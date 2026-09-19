"""Native function descriptors and argument validation, without an MCP service."""
from __future__ import annotations
from dataclasses import dataclass
import inspect
from typing import get_type_hints, Any
from pydantic import ConfigDict, create_model

@dataclass
class NativeFunction:
    name: str
    fn: Any
    description: str
    arguments: Any

class NativeRegistry:
    def __init__(self, name, instructions=''):
        self.name = name
        self.instructions = instructions
        self.functions = {}

    def tool(self):
        def register(fn):
            hints = get_type_hints(fn)
            fields = {name: (hints.get(name, Any), ... if parameter.default is inspect.Parameter.empty else parameter.default) for name, parameter in inspect.signature(fn).parameters.items()}
            arguments = create_model(fn.__name__ + 'Arguments', __config__=ConfigDict(extra='forbid'), **fields)
            self.functions[fn.__name__] = NativeFunction(fn.__name__, fn, inspect.getdoc(fn) or fn.__name__, arguments)
            return fn
        return register

    def descriptors(self, read_only):
        return [{'name': item.name, 'description': item.description, 'inputSchema': item.arguments.model_json_schema(), 'readOnly': item.name in read_only} for item in self.functions.values()]

    def call(self, name, arguments):
        if name not in self.functions:
            raise PermissionError('This visualization function is unavailable in the current mode.')
        item = self.functions[name]
        values = item.arguments.model_validate(arguments)
        return item.fn(**values.model_dump())
