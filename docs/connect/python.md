# Connect a Python app (Flask, Django, FastAPI)

Only needed for the **HTTP** connection type. Databases, OpenAPI systems and MCP servers connect with no code.

OpsPulse signs every request. Verify it before doing anything:

```python
import hashlib, hmac, json, time

TOLERANCE = 300  # seconds

def verify_opspulse(secret: str, method: str, path_with_query: str, raw_body: bytes, headers) -> dict:
    """Returns {"request_id", "mode", "body"} or raises PermissionError."""
    sig = headers.get("x-opspulse-signature", "")
    request_id = headers.get("x-opspulse-request-id")
    mode = headers.get("x-opspulse-mode")
    if not sig or not request_id or mode not in ("execute", "preview", "undo"):
        raise PermissionError("Missing OpsPulse headers")
    parts = dict(p.split("=", 1) for p in sig.split(","))
    t, v1 = int(parts.get("t", "0")), parts.get("v1", "")
    if abs(time.time() - t) > TOLERANCE:
        raise PermissionError("Signature expired")
    body_hash = hashlib.sha256(raw_body).hexdigest()
    payload = f"{t}.{request_id}.{method.upper()}.{path_with_query}.{body_hash}".encode()
    expected = hmac.new(secret.encode(), payload, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, v1):
        raise PermissionError("Invalid signature")
    return {"request_id": request_id, "mode": mode, "body": json.loads(raw_body or b"{}")}
```

Flask example:

```python
from flask import Flask, request, jsonify
import os

app = Flask(__name__)
SECRET = os.environ["OPSPULSE_SECRET"]

@app.post("/opspulse/orders/<order_id>/refund")
def refund(order_id):
    try:
        req = verify_opspulse(SECRET, request.method, request.full_path.rstrip("?"), request.get_data(), request.headers)
    except PermissionError as e:
        return jsonify(error=str(e)), 401
    if req["mode"] == "preview":
        return jsonify(changes=[{"label": f"Order {order_id}", "before": "Paid", "after": "Refunded"}], warnings=[])
    # ... do the refund once per req["request_id"] ...
    return jsonify(result={"refunded": True})
```

Responses: `preview` → `{changes, warnings}`, `execute` → `{result, undoToken?}`, undo requests arrive at `POST /opspulse/undo` with `{action, undoToken}`, errors → non-2xx with `{error}`. See `docs/gateway-contract.md`.
