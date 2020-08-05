# -*- coding: utf-8 -*-
import ast
import builtins
from contextlib import contextmanager
import logging
from typing import cast, TYPE_CHECKING

from ..analysis.attr_symbols import AttrSubSymbolChain, GetAttrSubSymbols
from ..data_symbol import DataSymbol, DataSymbolType
from ..scope import NamespaceScope
from ..utils import retrieve_namespace_attr_or_sub

if TYPE_CHECKING:
    from typing import Any, Dict, List, Optional, Set, Tuple, Union
    from ..safety import NotebookSafety
    from ..scope import Scope
    DeepRef = Tuple[int, Optional[str], Tuple[Union[str, AttrSubSymbolChain], ...]]
    Mutation = Tuple[int, Tuple[Union[str, AttrSubSymbolChain], ...]]
    RefCandidate = Optional[Tuple[int, int, Optional[str]]]
    SavedStoreData = Tuple[NamespaceScope, Any, str, bool]
    TextualCallNestingStackFrame = Tuple[Scope, bool]
    TextualCallNestingStack = List[TextualCallNestingStackFrame]
    AttrSubStackFrame = Tuple[
        List[SavedStoreData], Set[DeepRef], Set[Mutation], List[Tuple[RefCandidate, Set[Union[str, AttrSubSymbolChain]]]], Scope, Scope, TextualCallNestingStack
    ]
    AttrSubStack = List[AttrSubStackFrame]

logger = logging.getLogger(__name__)
logger.setLevel(logging.WARNING)


class AttrSubTracingManager(object):
    def __init__(self, safety: 'NotebookSafety',
                 active_scope: 'Scope', trace_event_counter: 'List[int]'):
        self.safety = safety
        self.original_active_scope = active_scope
        self.active_scope = active_scope
        self.trace_event_counter = trace_event_counter
        self.attrsub_tracer_name = '_NBSAFETY_ATTR_TRACER'
        self.end_tracer_name = '_NBSAFETY_ATTR_TRACER_END'
        self.arg_recorder_name = '_NBSAFETY_ARG_RECORDER'
        self.scope_pusher_name = '_NBSAFETY_SCOPE_PUSHER'
        self.scope_popper_name = '_NBSAFETY_SCOPE_POPPER'
        setattr(builtins, self.attrsub_tracer_name, self.attrsub_tracer)
        setattr(builtins, self.end_tracer_name, self.end_tracer)
        setattr(builtins, self.arg_recorder_name, self.arg_recorder)
        setattr(builtins, self.scope_pusher_name, self.scope_pusher)
        setattr(builtins, self.scope_popper_name, self.scope_popper)
        self.ast_transformer = AttrSubTracingNodeTransformer(
            self.attrsub_tracer_name, self.end_tracer_name, self.arg_recorder_name,
            self.scope_pusher_name, self.scope_popper_name,
        )
        self.loaded_data_symbols: Set[DataSymbol] = set()
        self.saved_store_data: List[SavedStoreData] = []
        self.deep_ref_candidates: List[Tuple[RefCandidate, Set[Union[str, AttrSubSymbolChain]]]] = []
        self.deep_refs: Set[DeepRef] = set()
        self.mutations: Set[Mutation] = set()
        self.nested_call_stack: TextualCallNestingStack = []
        self.stack: AttrSubStack = []
        self._waiting_for_call = False

    @property
    def active_scope_for_call(self) -> 'Scope':
        if self._waiting_for_call:
            return self.nested_call_stack[-1][0]
        return self.active_scope

    def __del__(self):
        if hasattr(builtins, self.attrsub_tracer_name):
            delattr(builtins, self.attrsub_tracer_name)
        if hasattr(builtins, self.end_tracer_name):
            delattr(builtins, self.end_tracer_name)
        if hasattr(builtins, self.arg_recorder_name):
            delattr(builtins, self.arg_recorder_name)
        if hasattr(builtins, self.scope_pusher_name):
            delattr(builtins, self.scope_pusher_name)
        if hasattr(builtins, self.scope_popper_name):
            delattr(builtins, self.scope_popper_name)

    def push_stack(self, new_scope: 'Scope'):
        self.stack.append((
            self.saved_store_data,
            self.deep_refs,
            self.mutations,
            self.deep_ref_candidates,
            self.active_scope,
            self.original_active_scope,
            self.nested_call_stack,
        ))
        self.saved_store_data = []
        self.deep_refs = set()
        self.mutations = set()
        self.deep_ref_candidates = []
        self.original_active_scope = new_scope
        self.active_scope = new_scope
        self.nested_call_stack = []

    def pop_stack(self):
        (
            self.saved_store_data,
            self.deep_refs,
            self.mutations,
            self.deep_ref_candidates,
            self.active_scope,
            self.original_active_scope,
            self.nested_call_stack,
        ) = self.stack.pop()

    @staticmethod
    def debug_attribute_tracer(obj, attr, ctx):
        logger.debug('%s attr %s of obj %s', ctx, attr, obj)
        return obj

    def attrsub_tracer(self, obj, attr_or_subscript, is_subscript, ctx, call_context, obj_name=None):
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
                # print('found class scope %s containing %s' % (class_scope, list(class_scope.all_data_symbols_this_indentation())))
                scope = class_scope.clone(obj)
                if obj_name is not None:
                    scope.scope_name = obj_name
                self.safety.namespaces[obj_id] = scope
            else:
                # print('no scope for class', obj.__class__)
                # if self.safety.trace_state.prev_trace_stmt.finished:
                #     # avoid creating new scopes if we already did this computation
                #     self.active_scope = None
                #     return obj
                try:
                    scope_name = next(iter(self.safety.aliases.get(obj_id, None))).name if obj_name is None else obj_name
                except (TypeError, StopIteration):
                    scope_name = '<unknown namespace>'

                # FIXME: brittle strategy for determining parent scope of obj
                if (
                    obj_name is not None and
                    obj_name not in self.safety.trace_state.prev_trace_stmt_in_cur_frame.frame.f_locals
                ):
                    parent_scope = self.safety.global_scope
                else:
                    parent_scope = self.active_scope
                scope = NamespaceScope(obj, self.safety, scope_name, parent_scope=parent_scope)
                self.safety.namespaces[obj_id] = scope
        self.active_scope = scope
        # if scope is None:  # or self.safety.trace_state.prev_trace_stmt.finished:
        #     if ctx in ('Store', 'AugStore'):
        #         self.active_scope = self.original_active_scope
        #     return obj
        if scope is None or self.safety.trace_state.prev_trace_stmt_in_cur_frame.finished:
            return obj
        elif ctx in ('Store', 'AugStore') and scope is not None:
            self.saved_store_data.append((scope, obj, attr_or_subscript, is_subscript))
            # reset active scope here
            self.active_scope = self.original_active_scope
        if ctx == 'Load':
            # save off event counter and obj_id
            # if event counter didn't change when we process the Call retval, and if the
            # retval is None, this is a likely signal that we have a mutation
            # TODO: this strategy won't work if the arguments themselves lead to traced function calls
            # print('looking for', attr_or_subscript)
            data_sym = scope.lookup_data_symbol_by_name_this_indentation(
                attr_or_subscript, is_subscript=is_subscript
            )
            if data_sym is None:
                try:
                    obj_attr_or_sub = retrieve_namespace_attr_or_sub(obj, attr_or_subscript, is_subscript)
                    symbol_type = DataSymbolType.SUBSCRIPT if is_subscript else DataSymbolType.DEFAULT
                    data_sym = DataSymbol(attr_or_subscript, symbol_type, obj_attr_or_sub, scope, self.safety, refresh_cached_obj=True)
                    # this is to prevent refs to the scope object from being considered as stale if we just load it
                    data_sym.defined_cell_num = data_sym.required_cell_num = scope.max_defined_timestamp
                    scope.put(attr_or_subscript, data_sym)
                    # print('put', data_sym, 'in', scope.full_namespace_path)
                    # FIXME: DataSymbols should probably register themselves with the alias manager at creation
                    self.safety.aliases[id(obj_attr_or_sub)].add(data_sym)
                except (AttributeError, KeyError, IndexError):
                    pass
            if call_context:
                self.deep_ref_candidates.append(((self.trace_event_counter[0], obj_id, obj_name), set()))
            elif data_sym is not None:
                # TODO: if we have a.b.c, will this consider a.b loaded as well as a.b.c? This is bad if so.
                self.loaded_data_symbols.add(data_sym)
        return obj

    def end_tracer(self, obj):
        if self.safety.trace_state.prev_trace_stmt_in_cur_frame.finished:
            self.active_scope = self.original_active_scope
            return obj
        if len(self.deep_ref_candidates) > 0:
            (evt_counter, obj_id, obj_name), recorded_args = self.deep_ref_candidates.pop()
            if evt_counter == self.trace_event_counter[0]:
                if obj is None:
                    self.mutations.add((obj_id, tuple(recorded_args)))
                else:
                    self.deep_refs.add((obj_id, obj_name, tuple(recorded_args)))
        # print('reset active scope from', self.active_scope, 'to', self.original_active_scope)
        self.active_scope = self.original_active_scope
        return obj

    def arg_recorder(self, obj, name):
        if self.safety.trace_state.prev_trace_stmt_in_cur_frame.finished:
            return obj
        if len(self.deep_ref_candidates) == 0:
            logger.error('Error: no associated symbol for recorded args; skipping recording')
            return obj

        if isinstance(name, str):
            self.deep_ref_candidates[-1][1].add(name)
        elif isinstance(name, tuple) and len(name) > 0:
            recorded_arg = AttrSubSymbolChain(name)
            self.deep_ref_candidates[-1][1].add(recorded_arg)

        return obj

    def scope_pusher(self, obj):
        # if self.safety.trace_state.prev_trace_stmt.finished:
        #     return obj
        self.nested_call_stack.append((self.active_scope, self._waiting_for_call))
        self._waiting_for_call = True
        self.active_scope = self.original_active_scope
        return obj

    def scope_popper(self, obj):
        # if self.safety.trace_state.prev_trace_stmt.finished:
        #     return obj
        self.active_scope, self._waiting_for_call = self.nested_call_stack.pop()
        return obj

    def stmt_transition_hook(self):
        self._waiting_for_call = False

    def reset(self):
        self.loaded_data_symbols = set()
        self.saved_store_data = []
        self.deep_refs = set()
        self.mutations = set()
        self.deep_ref_candidates = []
        self.active_scope = self.original_active_scope
        # self.nested_call_stack = []
        # self.stmt_transition_hook()


class AttrSubTracingNodeTransformer(ast.NodeTransformer):
    def __init__(self, attrsub_tracer: str, end_tracer: str, arg_recorder: str, scope_pusher: str, scope_popper: str):
        self.attrsub_tracer = attrsub_tracer
        self.end_tracer = end_tracer
        self.arg_recorder = arg_recorder
        self.scope_pusher = scope_pusher
        self.scope_popper = scope_popper
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
        is_load = isinstance(node.ctx, ast.Load)
        is_subscript = isinstance(node, ast.Subscript)
        # TODO: expand beyond simple slices
        if is_subscript:
            sub_node = cast(ast.Subscript, node)
            if isinstance(sub_node.slice, ast.Index):
                attr_or_sub = sub_node.slice.value
            else:
                logger.debug('unimpled slice: %s', sub_node.slice)
                return node
            # elif isinstance(sub_node.slice, ast.Slice):
            #     raise ValueError('unimpled slice: %s' % sub_node.slice)
            # elif isinstance(sub_node.slice, ast.ExtSlice):
            #     raise ValueError('unimpled slice: %s' % sub_node.slice)
            # else:
            #     raise ValueError('unexpected slice: %s' % sub_node.slice)
        else:
            attr_node = cast(ast.Attribute, node)
            attr_or_sub = ast.Str(attr_node.attr)

        extra_args = []
        if isinstance(node.value, ast.Name):
            extra_args = [ast.Str(node.value.id)]

        with self.attrsub_load_context():
            replacement_value = ast.Call(
                func=ast.Name(self.attrsub_tracer, ast.Load()),
                args=[
                    self.visit(node.value),
                    attr_or_sub,
                    ast.NameConstant(is_subscript),
                    ast.Str(node.ctx.__class__.__name__),
                    ast.NameConstant(call_context),
                ] + extra_args,
                keywords=[]
            )
        ast.copy_location(replacement_value, node.value)
        node.value = replacement_value
        new_node: Union[ast.Attribute, ast.Subscript, ast.Call] = node
        if not self.inside_attrsub_load_chain and is_load:
            new_node = ast.Call(
                func=ast.Name(self.end_tracer, ast.Load()),
                args=[node],
                keywords=[]
            )
        return new_node

    def _get_replacement_args(self, args, should_record):
        replacement_args = []
        for arg in args:
            chain = GetAttrSubSymbols()(arg)
            statically_resolvable = []
            for sym in chain.symbols:
                # TODO: only handles attributes properly; subscripts will break
                if not isinstance(sym, str):
                    break
                statically_resolvable.append(ast.Str(sym))
            statically_resolvable = ast.Tuple(elts=statically_resolvable, ctx=ast.Load())
            maybe_kwarg = getattr(arg, 'value', arg)
            with self.attrsub_load_context(False):
                visited_maybe_kwarg = self.visit(maybe_kwarg)
            argrecord_args = [visited_maybe_kwarg, statically_resolvable]
            if should_record:
                new_arg_value = cast(ast.expr, ast.Call(
                    func=ast.Name(self.arg_recorder, ast.Load()),
                    args=argrecord_args,
                    keywords=[]
                ))
            else:
                new_arg_value = visited_maybe_kwarg
            ast.copy_location(new_arg_value, maybe_kwarg)
            if hasattr(arg, 'value'):
                setattr(arg, 'value', new_arg_value)
            else:
                arg = new_arg_value
            replacement_args.append(arg)
        return replacement_args

    def visit_Call(self, node: ast.Call):
        is_attrsub = False
        if isinstance(node.func, (ast.Attribute, ast.Subscript)):
            is_attrsub = True
            with self.attrsub_load_context():
                node.func = self.visit_Attribute_or_Subscript(node.func, call_context=True)

            # TODO: need a way to rewrite ast of attribute and subscript args,
            #  and to process these separately from outer rewrite

        node.args = self._get_replacement_args(node.args, is_attrsub)
        node.keywords = self._get_replacement_args(node.keywords, is_attrsub)

        # in order to ensure that the args are processed with appropriate active scope,
        # we need to push current active scope before processing the args and pop after
        # (pop happens on function return as opposed to in tracer)
        node.func = ast.Call(
            func=ast.Name(self.scope_pusher, ast.Load()),
            args=[node.func],
            keywords=[],
        )

        node = ast.Call(
            func=ast.Name(self.scope_popper, ast.Load()),
            args=[node],
            keywords=[]
        )

        if self.inside_attrsub_load_chain:
            return node

        replacement_node = ast.Call(
            func=ast.Name(self.end_tracer, ast.Load()),
            args=[node],
            keywords=[]
        )
        ast.copy_location(replacement_node, node)
        return replacement_node
