$root=Split-Path -Parent $MyInvocation.MyCommand.Path
$repo=Resolve-Path "$root\.."

$desktop=[Environment]::GetFolderPath("Desktop")

$ws=New-Object -ComObject WScript.Shell
$shortcut=$ws.CreateShortcut("$desktop\AgenC.lnk")

$shortcut.TargetPath="powershell.exe"
$shortcut.Arguments="-ExecutionPolicy Bypass -File `"$root\start-agenc.ps1`""
$shortcut.IconLocation="$root\moon.ico,0"
$shortcut.WorkingDirectory=$repo

$shortcut.Save()

Write-Host "?? AgenC desktop icon installed"
