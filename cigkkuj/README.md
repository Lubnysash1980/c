# 🤖 Cybra Cloud Full

Ports: API 8088, Parliament 8092, DEX 8094, Bio 8098

## Install & Run (Termux)

```bash
unzip cybra_cloud_full.zip -d $HOME/cybra_cloud_full_src
cd $HOME/cybra_cloud_full_src
bash install.sh
bash start.sh
```

## GitHub Auto-Update

Authenticate once:
```bash
gh auth login
```

Then you can publish the zip as a release from your device (optional).

## Parliament Task Example
```bash
curl -X POST http://127.0.0.1:8092/task -H 'Content-Type: application/json'  -d '{"kind":"check_payment","payload":{"order":"Fold7"}}'
```

## Bio-Portal
```bash
curl -H "biometric_token: YOUR_TOKEN" http://127.0.0.1:8098/portal
```
