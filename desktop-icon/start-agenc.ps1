Set-Location (Split-Path -Parent $MyInvocation.MyCommand.Path)

Start-Process powershell -ArgumentList "-NoExit","-Command","node runtime\dist\bin\agenc-runtime.js start --foreground --config .\.agenc-runtime.json"

Start-Sleep 4

Start-Process powershell -ArgumentList "-NoExit","-Command","cd web; npm run dev"

Start-Sleep 6

Start-Process "http://localhost:5173"
