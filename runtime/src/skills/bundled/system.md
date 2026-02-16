---
name: system
description: Basic system operations for file management, processes, and network info
version: 1.0.0
metadata:
  agenc:
    tags:
      - system
      - utilities
      - shell
---
# System Operations

Basic system operations for file management, process information, network diagnostics, and environment inspection.

## File Operations

```bash
ls -la <PATH>
cp <SOURCE> <DESTINATION>
mv <SOURCE> <DESTINATION>
mkdir -p <DIRECTORY>
rm <FILE>
cat <FILE>
```

### Search Files

```bash
find <PATH> -name "*.ts" -type f
grep -r "pattern" <PATH> --include="*.ts"
```

## Process Management

```bash
ps aux
ps aux | grep <PROCESS_NAME>
kill <PID>
kill -9 <PID>
```

### Disk and Memory

```bash
df -h
du -sh <PATH>
free -h
```

## Network Info

```bash
curl -s <URL>
curl -s -o /dev/null -w "%{http_code}" <URL>
wget <URL> -O <OUTPUT_FILE>
```

### Port and Connection Info

```bash
ss -tlnp
netstat -tlnp
lsof -i :<PORT>
```

## Environment Variables

```bash
env
echo $PATH
export MY_VAR="value"
printenv <VAR_NAME>
```

## System Info

```bash
uname -a
hostname
whoami
uptime
```
