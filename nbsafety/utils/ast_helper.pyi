# -*- coding: utf-8 -*-
import sys
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from typing import Any, Optional
    import ast

class FastAst:
    _LOCATION_OF_NODE: 'Optional[ast.AST]' = None

    @staticmethod
    def location_of(*args, **kwargs) -> 'Any': ...

    @staticmethod
    def kw(arg: str, value: 'ast.expr') -> 'ast.keyword': ...

    @staticmethod
    def parse(*args, **kwargs) -> 'ast.Module': ...

    @staticmethod
    def Call(*args, **kwargs) -> 'ast.Call': ...
    @staticmethod
    def Name(*args, **kwargs) -> 'ast.Name': ...
    @staticmethod
    def NameConstant(*args, **kwargs) -> 'ast.NameConstant': ...
    @staticmethod
    def Tuple(*args, **kwargs) -> 'ast.Tuple': ...
    @staticmethod
    def keyword(*args, **kwargs) -> 'ast.keyword': ...

    if sys.version_info <= (3, 7):
        @staticmethod
        def Num(*args, **kwargs) -> 'ast.Num': ...
        @staticmethod
        def Str(*args, **kwargs) -> 'ast.Str': ...
    else:
        @staticmethod
        def Num(*args, **kwargs) -> 'ast.Constant': ...
        @staticmethod
        def Str(*args, **kwargs) -> 'ast.Constant': ...
        @staticmethod
        def Constant(*args, **kwargs) -> 'ast.Constant': ...