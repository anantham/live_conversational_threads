"""Validate completion metadata before interpreting structured response content."""


def check_structured_completion(response, *, output_limit):
    choice = response['choices'][0]
    reason = choice.get('finish_reason')
    known = {'stop', 'length', 'max_tokens', 'content_filter', 'tool_calls', 'function_call'}
    safe_reason = reason if isinstance(reason, str) and reason in known else ('unreported' if reason is None else 'unknown')
    usage = response.get('usage') if isinstance(response.get('usage'), dict) else {}
    counts = {key: value if type(value := usage.get(key)) is int and value >= 0 else None
              for key in ('completion_tokens', 'prompt_tokens')}
    metadata = {'finish_reason': safe_reason, **counts, 'output_limit': output_limit}
    if safe_reason in {'length', 'max_tokens', 'content_filter', 'tool_calls', 'function_call'}:
        detail = ' '.join(f'{key}={value}' for key, value in metadata.items())
        raise ValueError(f'Incomplete structured completion: {detail}')
    return metadata
