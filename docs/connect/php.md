# Connect a PHP app (Laravel, WordPress, plain PHP)

Only needed for the **HTTP** connection type. Databases, OpenAPI systems and MCP servers connect with no code.

```php
<?php
function verify_opspulse(string $secret): array {
    $sig = $_SERVER['HTTP_X_OPSPULSE_SIGNATURE'] ?? '';
    $requestId = $_SERVER['HTTP_X_OPSPULSE_REQUEST_ID'] ?? '';
    $mode = $_SERVER['HTTP_X_OPSPULSE_MODE'] ?? '';
    if ($sig === '' || $requestId === '' || !in_array($mode, ['execute', 'preview', 'undo'], true)) {
        throw new RuntimeException('Missing OpsPulse headers');
    }
    parse_str(str_replace(',', '&', $sig), $parts);
    $t = (int)($parts['t'] ?? 0);
    if (abs(time() - $t) > 300) throw new RuntimeException('Signature expired');

    $raw = file_get_contents('php://input');
    $payload = $t . '.' . $requestId . '.' . strtoupper($_SERVER['REQUEST_METHOD']) . '.' . $_SERVER['REQUEST_URI'] . '.' . hash('sha256', $raw);
    $expected = hash_hmac('sha256', $payload, $secret);
    if (!hash_equals($expected, $parts['v1'] ?? '')) throw new RuntimeException('Invalid signature');

    return ['request_id' => $requestId, 'mode' => $mode, 'body' => json_decode($raw ?: '{}', true)];
}

try {
    $req = verify_opspulse(getenv('OPSPULSE_SECRET'));
} catch (RuntimeException $e) {
    http_response_code(401);
    echo json_encode(['error' => $e->getMessage()]);
    exit;
}

header('Content-Type: application/json');
if ($req['mode'] === 'preview') {
    echo json_encode(['changes' => [['label' => 'Status', 'before' => 'Draft', 'after' => 'Published']], 'warnings' => []]);
    exit;
}
// ... perform the action once per $req['request_id'] ...
echo json_encode(['result' => ['ok' => true]]);
```

`$_SERVER['REQUEST_URI']` must be the path + query OpsPulse called (behind a proxy that rewrites paths, use the original path). Response shapes are in `docs/gateway-contract.md`.
