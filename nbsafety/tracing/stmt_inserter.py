# -*- coding: future_annotations -*-
import ast
import logging
from typing import cast, TYPE_CHECKING

from nbsafety.extra_builtins import EMIT_EVENT, TRACING_ENABLED, make_loop_guard_name
from nbsafety.singletons import tracer  # FIXME: get rid of this
from nbsafety.tracing.trace_events import TraceEvent
from nbsafety.utils import fast

if TYPE_CHECKING:
    from typing import Dict, List, Optional, Set, Union
    from nbsafety.types import CellId


logger = logging.getLogger(__name__)


_INSERT_STMT_TEMPLATE = '{}("{{evt}}", {{stmt_id}})'.format(EMIT_EVENT)


def _get_parsed_insert_stmt(stmt: ast.stmt, evt: TraceEvent) -> ast.stmt:
    with fast.location_of(stmt):
        return fast.parse(_INSERT_STMT_TEMPLATE.format(evt=evt.value, stmt_id=id(stmt))).body[0]


def _get_parsed_append_stmt(
    stmt: ast.stmt, ret_expr: ast.expr = None, evt: TraceEvent = TraceEvent.after_stmt, **kwargs
) -> ast.stmt:
    with fast.location_of(stmt):
        ret = cast(ast.Expr, _get_parsed_insert_stmt(stmt, evt))
        if ret_expr is not None:
            kwargs['ret'] = ret_expr
        ret_value = cast(ast.Call, ret.value)
        ret_value.keywords = fast.kwargs(**kwargs)
    ret.lineno = getattr(stmt, 'end_lineno', ret.lineno)
    return ret


class StripGlobalAndNonlocalDeclarations(ast.NodeTransformer):
    def visit_Global(self, node: ast.Global) -> ast.Pass:
        with fast.location_of(node):
            return fast.Pass()

    def visit_Nonlocal(self, node: ast.Nonlocal) -> ast.Pass:
        with fast.location_of(node):
            return fast.Pass()


class StatementInserter(ast.NodeTransformer):
    def __init__(self, cell_id: Optional[CellId], orig_to_copy_mapping: Dict[int, ast.AST]):
        self._cell_id: Optional[CellId] = cell_id
        self._orig_to_copy_mapping = orig_to_copy_mapping
        self._init_stmt_inserted = False
        self._global_nonlocal_stripper = StripGlobalAndNonlocalDeclarations()

    def _handle_loop_body(self, node: Union[ast.For, ast.While], orig_body: List[ast.AST]) -> List[ast.AST]:
        loop_node_copy = cast('Union[ast.For, ast.While]', self._orig_to_copy_mapping[id(node)])
        loop_guard = make_loop_guard_name(loop_node_copy)
        tracer().loop_guards.add(loop_guard)
        with fast.location_of(loop_node_copy):
            return [
                fast.If(
                    test=fast.Name(loop_guard, ast.Load()),
                    body=loop_node_copy.body,
                    orelse=[
                        fast.Try(
                            body=self._global_nonlocal_stripper.visit(ast.Module(orig_body)).body,
                            handlers=[],
                            orelse=[],
                            finalbody=[
                                _get_parsed_append_stmt(
                                    cast(ast.stmt, loop_node_copy),
                                    evt=(
                                        TraceEvent.after_for_loop_iter if isinstance(node, ast.For)
                                        else TraceEvent.after_while_loop_iter
                                    ),
                                    loop_guard=fast.Str(loop_guard),
                                ),
                            ],
                        ),
                    ],
                ),
            ]

    def _handle_function_body(
        self, node: Union[ast.FunctionDef, ast.AsyncFunctionDef], orig_body: List[ast.AST]
    ) -> List[ast.AST]:
        fundef_copy = cast('Union[ast.FunctionDef, ast.AsyncFunctionDef]', self._orig_to_copy_mapping[id(node)])
        with fast.location_of(fundef_copy):
            return [
                fast.If(
                    test=fast.parse(f'getattr(builtins, "{TRACING_ENABLED}", False)').body[0].value,  # type: ignore
                    body=orig_body,
                    orelse=self._global_nonlocal_stripper.visit(fundef_copy).body,
                ),
            ]

    def generic_visit(self, node):
        for name, field in ast.iter_fields(node):
            if isinstance(field, ast.AST):
                setattr(node, name, self.visit(field))
            elif isinstance(field, list):
                new_field = []
                for inner_node in field:
                    if isinstance(inner_node, ast.stmt):
                        stmt_copy = cast(ast.stmt, self._orig_to_copy_mapping[id(inner_node)])
                        if not self._init_stmt_inserted:
                            assert isinstance(node, ast.Module)
                            self._init_stmt_inserted = True
                            with fast.location_of(stmt_copy):
                                new_field.extend(fast.parse(
                                    f'import builtins; {EMIT_EVENT}("{TraceEvent.init_cell.value}", None, cell_id="{self._cell_id}")'
                                ).body)
                        new_field.append(_get_parsed_insert_stmt(stmt_copy, TraceEvent.before_stmt))
                        if isinstance(inner_node, ast.Expr) and isinstance(node, ast.Module) and name == 'body':
                            val = inner_node.value
                            while isinstance(val, ast.Expr):
                                val = val.value
                            new_field.append(_get_parsed_append_stmt(stmt_copy, ret_expr=val))
                        else:
                            new_field.append(self.visit(inner_node))
                            if not isinstance(inner_node, ast.Return):
                                new_field.append(_get_parsed_append_stmt(stmt_copy))
                        if isinstance(node, ast.Module) and name == 'body':
                            assert not isinstance(inner_node, ast.Return)
                            new_field.append(_get_parsed_append_stmt(stmt_copy, evt=TraceEvent.after_module_stmt))
                    elif isinstance(inner_node, ast.AST):
                        new_field.append(self.visit(inner_node))
                    else:
                        new_field.append(inner_node)
                if name == 'body':
                    if isinstance(node, (ast.For, ast.While)):
                        new_field = self._handle_loop_body(node, new_field)
                    elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                        new_field = self._handle_function_body(node, new_field)
                setattr(node, name, new_field)
            else:
                continue
        return node
