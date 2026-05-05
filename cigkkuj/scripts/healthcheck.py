import psutil, json, os
print(json.dumps({"cpu": psutil.cpu_count(), "mem": psutil.virtual_memory().total, "ok": True}))
