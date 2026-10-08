"""Read pipeline record artifacts one company at a time using Python's decoder.

No alternate number parser or JSON serializer: record values retain the same
types as json.load. Consumers must exhaust the iterator to validate the tail.
"""
import json


def object_members(handle, decoder=None, chunk_size=1024 * 1024):
    """Yield (key, value, is_record) from a top-level object.

Only the records array is streamed; other values use the normal decoder.
"""
    decoder = decoder or json.JSONDecoder()
    buffer, position, ended = '', 0, False

    def fill(size=chunk_size):
        nonlocal buffer, position, ended
        buffer = buffer[position:]
        position = 0
        chunk = handle.read(size)
        ended = not chunk
        buffer += chunk

    def peek():
        nonlocal position
        while True:
            while position < len(buffer) and buffer[position] in ' \r\n\t':
                position += 1
            if position < len(buffer) or ended:
                return buffer[position:position + 1]
            fill()

    def expect(character):
        nonlocal position
        if peek() != character:
            raise ValueError('Expected JSON ' + character)
        position += 1

    def value():
        nonlocal buffer, position
        peek()
        # Discard the previous record before admitting the next one.
        if position:
            buffer = buffer[position:]
            position = 0
        while True:
            try:
                result, end = decoder.raw_decode(buffer, position)
                # A number may continue in the next chunk.
                if not ended and (end == len(buffer) or buffer[end] not in ' \r\n\t,:]}'):
                    fill()
                    continue
                position = end
                return result
            except json.JSONDecodeError:
                if ended:
                    raise
                # Large individual companies need larger chunks, not repeated
                # reparsing at every megabyte. Memory still tracks one record.
                fill(max(chunk_size, len(buffer)))

    expect('{')
    if peek() != '}':
        while True:
            key = value()
            if not isinstance(key, str):
                raise ValueError('JSON object key must be a string')
            expect(':')
            if key == 'records' and peek() == '[':
                expect('[')
                # Announce the array even when it is empty.
                yield key, [], False
                if peek() != ']':
                    while True:
                        yield key, value(), True
                        if peek() == ']':
                            break
                        expect(',')
                expect(']')
            else:
                yield key, value(), False
            if peek() == '}':
                break
            expect(',')
    expect('}')
    if peek():
        raise ValueError('Extra data after JSON object')


def record_artifact(path):
    """Return the small header and a fresh iterator over emitted records.

Pipeline writers emit unique keys, with metadata before records. The second
pass reads only that small header again, without retaining all companies.
"""
    header = {}
    with path.open(encoding='utf-8') as handle:
        for key, value, is_record in object_members(handle):
            if key == 'records':
                if not isinstance(value, list):
                    raise ValueError('Filing records must be an array')
                break
            header[key] = value

    def records():
        seen_records = False
        with path.open(encoding='utf-8') as handle:
            for key, value, is_record in object_members(handle):
                if key == 'records' and not is_record:
                    if not isinstance(value, list):
                        raise ValueError('Filing records must be an array')
                    if seen_records:
                        raise ValueError('Duplicate filing records field')
                    seen_records = True
                if is_record:
                    yield value
    return {**header, 'records': records()}
