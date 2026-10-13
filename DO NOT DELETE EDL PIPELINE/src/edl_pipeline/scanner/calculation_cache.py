"""Reuse pure calculations only within one immutable stock evaluation."""
from contextlib import contextmanager
from contextvars import ContextVar
from functools import wraps

import pandas as pd


_current = ContextVar('scanner_calculations', default=None)


@contextmanager
def calculation_cache():
    token = _current.set({})
    try:
        yield
    finally:
        _current.reset(token)


def memoized(function):
    @wraps(function)
    def calculate(*args, **kwargs):
        cache = _current.get()
        if cache is None:
            return function(*args, **kwargs)
        def identity(arg):
            return ('frame', id(arg)) if isinstance(arg, (pd.DataFrame, pd.Series)) else arg
        key = (function, tuple(map(identity, args)), tuple((name, identity(arg)) for name, arg in sorted(kwargs.items())))
        try:
            hash(key)
        except TypeError:
            return function(*args, **kwargs)
        if key not in cache:
            # Retain input objects as well as results: temporary Series ids
            # must not be reused for a different calculation in this scope.
            cache[key] = (args, kwargs, function(*args, **kwargs))
        return cache[key][2]
    return calculate
