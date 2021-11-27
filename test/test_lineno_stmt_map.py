# -*- coding: future_annotations -*-
import ast
import textwrap
from typing import TYPE_CHECKING

from nbsafety.tracing.stmt_mapper import StatementMapper
from .utils import make_safety_fixture

if TYPE_CHECKING:
    from typing import Dict


_safety_fixture, _ = make_safety_fixture()


def compute_lineno_to_stmt_mapping(code: str) -> Dict[int, ast.stmt]:
    mapper = StatementMapper({}, {})
    mapper(ast.parse(textwrap.dedent(code).strip()))
    return mapper.line_to_stmt_map


def test_for_loop():
    code = (
        """
        for i in range(10):
            a: int = i
            b = a + i
            lst: List[int] = [a, b]
        """
    )
    mapping = compute_lineno_to_stmt_mapping(code)
    assert isinstance(mapping[1], ast.For)
    assert isinstance(mapping[2], ast.AnnAssign)
    assert isinstance(mapping[3], ast.Assign)
    assert isinstance(mapping[4], ast.AnnAssign)


def test_multiline_for_loop():
    code = (
        """
        for i in [
            0,
            1,
            2,
            3,
            4,
        ]:
            a = i
            b = a + i
            lst = [a, b]
        """
    )
    mapping = compute_lineno_to_stmt_mapping(code)
    # for i in range(1, 7):
    #     assert isinstance(mapping[i], ast.For)
    # assert 7 not in mapping
    assert isinstance(mapping[1], ast.For)
    for i in range(2, 8):
        assert i not in mapping
    assert isinstance(mapping[8], ast.Assign)
    assert isinstance(mapping[9], ast.Assign)
    assert isinstance(mapping[10], ast.Assign)


def test_if():
    code = (
        """
        if True:
            x = 0
        else:
            x: int = 0
        """
    )
    mapping = compute_lineno_to_stmt_mapping(code)
    assert isinstance(mapping[1], ast.If)
    assert isinstance(mapping[2], ast.Assign)
    assert 3 not in mapping
    assert isinstance(mapping[4], ast.AnnAssign)
