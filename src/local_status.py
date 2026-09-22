import json
from claude_hooks import snapshot, allowed
print(json.dumps(snapshot(allowed())))
