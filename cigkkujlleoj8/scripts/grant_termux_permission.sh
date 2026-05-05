    #!/bin/bash
    # Termux helper: set token for API and adjust file permissions
    TOKEN=${1:-cybra-secret-token}
    BASE_DIR=$(cd "$(dirname "$0")/.." && pwd)
    python3 - <<PY
import json, os
cfg = os.path.join('$BASE_DIR','data','config.json')
c = json.load(open(cfg))
c['auth_token'] = '$TOKEN'
open(cfg,'w').write(json.dumps(c, indent=2))
print('Wrote token to', cfg)
PY
    chmod -R 700 "$BASE_DIR/modules" "$BASE_DIR/data/logs"
    echo "Permissions set. Token: $TOKEN"
