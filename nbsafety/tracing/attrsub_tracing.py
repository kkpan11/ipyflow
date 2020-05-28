# -*- coding: utf-8 -*-
import ast
import builtins
from contextlib import contextmanager
import logging
from typing import cast, TYPE_CHECKING

from ..data_symbol import DataSymbol
from ..scope import NamespaceScope

if TYPE_CHECKING:
    from typing import Any, Dict, List, Optional, Set, Tuple, Union
    DeepRef = Tuple[int, Optional[str], Tuple[str, ...]]
    Mutation = Tuple[int, Tuple[str, ...]]
    RefCandidate = Optional[Tuple[int, int, Optional[str]]]
    SavedStoreData = Tuple[NamespaceScope, Any, str, bool]
    from ..safety import DependencySafety
    from ..scope import Scope

logger = logging.getLogger(__name__)


class AttrSubTracingManager(object):
    def __init__(self, safety: 'DependencySafety',
                 active_scope: 'Scope', trace_event_counter: 'List[int]'):
        self.safety = safety
        self.original_active_scope = active_scope
        self.active_scope = active_scope
        self.trace_event_counter = trace_event_counter
        self.start_tracer_name = '_NBSAFETY_ATTR_TRACER_START'
        self.end_tracer_name = '_NBSAFETY_ATTR_TRACER_END'
        self.arg_recorder_name = '_NBSAFETY_ARG_RECORDER'
        setattr(builtins, self.start_tracer_name, self.attrsub_tracer)
        setattr(builtins, self.end_tracer_name, self.expr_tracer)
        setattr(builtins, self.arg_recorder_name, self.arg_recorder)
        self.ast_transformer = AttrSubTracingNodeTransformer(
            self.start_tracer_name, self.end_tracer_name, self.arg_recorder_name
        )
        self.loaded_data_symbols: Set[DataSymbol] = set()
        self.saved_store_data: List[SavedStoreData] = []
        self.mutations: Set[Mutation] = set()
        self.deep_refs: Set[DeepRef] = set()
        self.recorded_args: Set[str] = set()
        self.stack: List[
            Tuple[List[SavedStoreData], Set[DeepRef], Set[Mutation], RefCandidate, Set[str], Scope, Scope]
        ] = []
        self.deep_ref_candidate: RefCandidate = None

    def __del__(self):
        if hasattr(builtins, self.start_tracer_name):
            delattr(builtins, self.start_tracer_name)
        if hasattr(builtins, self.end_tracer_name):
            delattr(builtins, self.end_tracer_name)
        if hasattr(builtins, self.arg_recorder_name):
            delattr(builtins, self.arg_recorder_name)

    def push_stack(self, new_scope: 'Scope'):
        self.stack.append((
            self.saved_store_data,
            self.deep_refs,
            self.mutations,
            self.deep_ref_candidate,
            self.recorded_args,
            self.active_scope,
            self.original_active_scope,
        ))
        self.saved_store_data = []
        self.deep_refs = set()
        self.mutations = set()
        self.recorded_args = set()
        self.original_active_scope = new_scope
        self.active_scope = new_scope

    def pop_stack(self):
        (
            self.saved_store_data,
            self.deep_refs,
            self.mutations,
            self.deep_ref_candidate,
            self.recorded_args,
            self.active_scope,
            self.original_active_scope,
        ) = self.stack.pop()

    @staticmethod
    def debug_attribute_tracer(obj, attr, ctx):
        logger.debug('%s attr %s of obj %s', ctx, attr, obj)
        return obj

    def attrsub_tracer(self, obj, attr_or_subscript, is_subscript, ctx,
                       call_context, override_active_scope, obj_name=None):
        if obj is None:
            return None
        if not isinstance(attr_or_subscript, (str, int)):
            return obj
        obj_id = id(obj)
        scope = self.safety.namespaces.get(obj_id, None)
        # print('%s attr %s of obj %s' % (ctx, attr, obj))
        if scope is None:
            class_scope = self.safety.namespaces.get(id(obj.__class__), None)
            if class_scope is not None and not is_subscript:
                # print('found class scope %s containing %s' % (class_scope, class_scope.all_data_syms_this_indentation().keys()))
                scope = class_scope.clone(obj_id)
                self.safety.namespaces[obj_id] = scope
            else:
                # print('no scope for class', obj.__class__)
                try:
                    scope_name = next(iter(self.safety.aliases[obj_id])).name
                except StopIteration:
                    scope_name = '<unknown namespace>'
                scope = NamespaceScope(obj_id, self.safety, scope_name, parent_scope=self.active_scope)
                self.safety.namespaces[obj_id] = scope
        # print('new active scope', scope)
        if override_active_scope:
            self.active_scope = scope
        if scope is None:
            return obj
        if ctx == 'Load':
            # save off event counter and obj_id
            # if event counter didn't change when we process the Call retval, and if the
            # retval is None, this is a likely signal that we have a mutation
            # TODO: this strategy won't work if the arguments themselves lead to traced function calls
            if call_context:
                self.deep_ref_candidate = (self.trace_event_counter[0], obj_id, obj_name)
            else:
                self.deep_ref_candidate = None
                data_sym = scope.lookup_data_symbol_by_name_this_indentation(attr_or_subscript)
                if data_sym is None:
                    try:
                        if is_subscript:
                            obj_attr_or_sub = obj[attr_or_subscript]
                        else:
                            obj_attr_or_sub = getattr(obj, attr_or_subscript)
                        data_sym = DataSymbol(attr_or_subscript, obj_attr_or_sub, scope,
                                              self.safety, is_subscript=is_subscript)
                        # this is to prevent refs to the scope object from being considered as stale if we just load it
                        data_sym.defined_cell_num = data_sym.required_cell_num = scope.max_defined_timestamp
                        scope.put(attr_or_subscript, data_sym)
                        # FIXME: DataSymbols should probably register themselves with the alias manager at creation
                        self.safety.aliases[id(obj_attr_or_sub)].add(data_sym)
                    except AttributeError:
                        pass
                self.loaded_data_symbols.add(data_sym)
        if ctx in ('Store', 'AugStore'):
            self.saved_store_data.append((scope, obj, attr_or_subscript, is_subscript))
        return obj

    def expr_tracer(self, obj):
        # print('reset active scope to', self.original_active_scope)
        if self.deep_ref_candidate is not None:
            evt_counter, obj_id, obj_name = self.deep_ref_candidate
            self.deep_ref_candidate = None
            if evt_counter == self.trace_event_counter[0]:
                if obj is None:
                    self.mutations.add((obj_id, tuple(self.recorded_args)))
                else:
                    self.deep_refs.add((obj_id, None, tuple(self.recorded_args)))
        self.active_scope = self.original_active_scope
        self.recorded_args = set()
        return obj

    def arg_recorder(self, obj, name):
        self.recorded_args.add(name)
        return obj

    def reset(self):
        self.loaded_data_symbols = set()
        self.saved_store_data = []
        self.deep_refs = set()
        self.mutations = set()
        self.deep_ref_candidate = None
        self.active_scope = self.original_active_scope


# TODO: handle subscripts
class AttrSubTracingNodeTransformer(ast.NodeTransformer):
    def __init__(self, start_tracer: str, end_tracer: str, arg_recorder: str):
        self.start_tracer = start_tracer
        self.end_tracer = end_tracer
        self.arg_recorder = arg_recorder
        self.inside_attrsub_load_chain = False

    @contextmanager
    def attrsub_load_context(self, override=True):
        old = self.inside_attrsub_load_chain
        self.inside_attrsub_load_chain = override
        yield
        self.inside_attrsub_load_chain = old

    def visit_Attribute(self, node: 'ast.Attribute', call_context=False):
        return self.visit_Attribute_or_Subscript(node, call_context)

    def visit_Subscript(self, node: 'ast.Subscript', call_context=False):
        return self.visit_Attribute_or_Subscript(node, call_context)

    def visit_Attribute_or_Subscript(self, node: 'Union[ast.Attribute, ast.Subscript]', call_context=False):
        override_active_scope = isinstance(node.ctx, ast.Load) or self.inside_attrsub_load_chain
        override_active_scope_arg = ast.Constant(override_active_scope)
        ast.copy_location(override_active_scope_arg, node)
        is_subscript = isinstance(node, ast.Subscript)
        if is_subscript:
            sub_node = cast(ast.Subscript, node)
            if isinstance(sub_node.slice, ast.Index):
                attr_or_sub = sub_node.slice.value
            elif isinstance(sub_node.slice, ast.Slice):
                raise ValueError('unimpled slice: %s' % sub_node.slice)
            elif isinstance(sub_node.slice, ast.ExtSlice):
                raise ValueError('unimpled slice: %s' % sub_node.slice)
            else:
                raise ValueError('unexpected slice: %s' % sub_node.slice)
        else:
            attr_node = cast(ast.Attribute, node)
            attr_or_sub = ast.Str(attr_node.attr)
        with self.attrsub_load_context(override_active_scope):
            replacement_value = ast.Call(
                func=ast.Name(self.start_tracer, ctx=ast.Load()),
                args=[
                    self.visit(node.value),
                    attr_or_sub,
                    ast.NameConstant(is_subscript),
                    ast.Str(node.ctx.__class__.__name__),
                    ast.NameConstant(call_context),
                    override_active_scope_arg
                ],
                keywords=[]
            )
        ast.copy_location(replacement_value, node.value)
        node.value = replacement_value
        new_node: Union[ast.Attribute, ast.Subscript, ast.Call] = node
        if not self.inside_attrsub_load_chain and override_active_scope:
            new_node = ast.Call(
                func=ast.Name(self.end_tracer, ctx=ast.Load()),
                args=[node],
                keywords=[]
            )
        return new_node

    def visit_Call(self, node: ast.Call):
        if not isinstance(node.func, ast.Attribute):
            return node
        assert isinstance(node.func.ctx, ast.Load)
        with self.attrsub_load_context():
            node.func = self.visit_Attribute(node.func, call_context=True)
        replacement_args = []
        for arg in node.args:
            if isinstance(arg, ast.Name):
                replacement_args.append(cast(ast.expr, ast.Call(
                    func=ast.Name(self.arg_recorder, ctx=ast.Load()),
                    args=[arg, ast.Str(arg.id)],
                    keywords=[]
                )))
                ast.copy_location(replacement_args[-1], arg)
            else:
                with self.attrsub_load_context(False):
                    replacement_args.append(self.visit(arg))
        node.args = replacement_args
        if self.inside_attrsub_load_chain:
            return node
        replacement_node = ast.Call(
            func=ast.Name(self.end_tracer, ctx=ast.Load()),
            args=[node],
            keywords=[]
        )
        ast.copy_location(replacement_node, node)
        return replacement_node
