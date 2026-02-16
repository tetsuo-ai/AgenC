---
name: system
description: Basic system operations — file management, process info, network diagnostics, and environment
version: 1.0.0
metadata:
  agenc:
    emoji: "🖥️"
    primaryEnv: node
    requires:
      os:
        - linux
        - macos
    tags:
      - system
      - files
      - process
      - network
      - diagnostics
---

# System Operations

Basic system administration, file management, and diagnostics.

## File Management

```bash
# List files with details
ls -la /path/to/dir

# Find files by pattern
find /path -name "*.ts" -type f

# Disk usage
du -sh /path/to/dir
df -h

# File permissions
chmod 644 file.txt
chmod 755 script.sh
chown user:group file.txt
```

## Process Management

```bash
# List running processes
ps aux | grep <name>

# Process tree
pstree -p

# Resource usage
top -l 1 -n 10    # macOS
top -bn1 | head   # Linux

# Kill a process
kill <PID>
kill -9 <PID>     # Force kill
```

## Network Diagnostics

```bash
# Check connectivity
ping -c 3 example.com

# DNS lookup
nslookup example.com
dig example.com

# Port check
nc -zv host 443

# Listening ports
lsof -i -P -n | grep LISTEN   # macOS
ss -tlnp                       # Linux

# HTTP request
curl -s -o /dev/null -w "%{http_code}" https://example.com
```

## Environment

```bash
# View environment variables
env | sort
echo $PATH

# Set environment variable (current session)
export MY_VAR=value

# Check OS info
uname -a
cat /etc/os-release  # Linux
sw_vers              # macOS
```

## Memory and CPU

```bash
# Memory usage
free -h             # Linux
vm_stat             # macOS

# CPU info
nproc               # Linux
sysctl -n hw.ncpu   # macOS

# Load average
uptime
```

## Archive Operations

```bash
# Create tar.gz
tar -czf archive.tar.gz /path/to/dir

# Extract tar.gz
tar -xzf archive.tar.gz

# Create zip
zip -r archive.zip /path/to/dir

# Extract zip
unzip archive.zip
```

## Common Pitfalls

- Always use absolute paths in scripts to avoid working directory issues
- Check disk space before large file operations
- Use `nohup` or `screen`/`tmux` for long-running processes over SSH
- Be cautious with `rm -rf` — double-check paths before executing
- Environment variables set with `export` only persist in the current shell session
