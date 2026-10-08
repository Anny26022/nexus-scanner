"""Bounded arithmetic over validated base facts; never executes user code."""
import math
import re


def evaluate_formula(source, resolve):
    if not isinstance(source, str) or not source.strip() or len(source) > 2048:
        raise ValueError('Base formula requires 1-2048 characters')
    pattern = re.compile(r'\s*(\d+(?:\.\d+)?|[A-Za-z][A-Za-z0-9_.]*|[()+*/-])')
    tokens = []
    position = 0
    source = source.strip()
    while position < len(source):
        match = pattern.match(source, position)
        if not match:
            raise ValueError('Invalid base formula token')
        tokens.append(match[1]); position = match.end()
    if len(tokens) > 64:
        raise ValueError('Base formula exceeds 64 tokens')
    cursor = 0

    def expression(depth=0, minimum=0):
        nonlocal cursor
        if depth > 8 or cursor >= len(tokens):
            raise ValueError('Invalid base formula depth or operand')
        token = tokens[cursor]; cursor += 1
        if token in ('+', '-'):
            left = expression(depth+1, 3)
            if left is not None and token == '-': left = -left
        elif token == '(':
            left = expression(depth+1)
            if cursor >= len(tokens) or tokens[cursor] != ')':
                raise ValueError('Unclosed base formula parenthesis')
            cursor += 1
        elif token[0].isdigit():
            left = float(token)
            if not math.isfinite(left): raise ValueError('Nonfinite base formula constant')
        elif token[0].isalpha():
            left = resolve(token)
        else:
            raise ValueError('Invalid base formula operand')
        priorities = {'+': 1, '-': 1, '*': 2, '/': 2}
        while cursor < len(tokens) and priorities.get(tokens[cursor], 0) > minimum:
            op = tokens[cursor]; cursor += 1
            right = expression(depth+1, priorities[op])
            if left is None or right is None or (op == '/' and right == 0):
                left = None
            else:
                left = {'+': lambda: left+right, '-': lambda: left-right,
                        '*': lambda: left*right, '/': lambda: left/right}[op]()
                if not math.isfinite(left): left = None
        return left

    result = expression()
    if cursor != len(tokens): raise ValueError('Unexpected base formula token')
    return result
