FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:1 \
    DISPLAY_WIDTH=1280 \
    DISPLAY_HEIGHT=1024 \
    DISPLAY_DEPTH=24 \
    PORT=9990 \
    HOME=/home/agenc

ENV PLAYWRIGHT_BROWSERS_PATH=/home/agenc/.cache/ms-playwright

# =============================================================================
# System packages
# =============================================================================
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Virtual display + desktop environment
    xvfb xfce4 xfce4-terminal xfce4-whiskermenu-plugin dbus-x11 xterm kitty \
    # File manager
    thunar \
    # GUI browser fallback
    epiphany-browser \
    # VNC
    x11vnc novnc websockify \
    # Input automation
    xdotool xclip xsel \
    # Screenshot + display info + SVG rendering
    scrot imagemagick x11-utils librsvg2-bin \
    # Process management
    supervisor \
    # Fonts (system + monospace for terminal/coding)
    fonts-liberation fonts-noto-color-emoji fonts-jetbrains-mono \
    # Theme + icons
    greybird-gtk-theme papirus-icon-theme adwaita-icon-theme-full \
    # Networking/utils
    curl ca-certificates wget gnupg \
    # Build essentials
    build-essential gcc g++ make cmake \
    # Developer tools
    git vim nano neovim tmux htop tree jq unzip sudo \
    # Modern CLI tools (agent-optimized)
    ripgrep fd-find bat fzf \
    # Video recording
    ffmpeg \
    # Python
    python3 python3-pip python3-venv \
    # Misc utilities
    bash-completion locales software-properties-common sqlite3 \
    && locale-gen en_US.UTF-8 \
    # =========================================================================
    # Playwright MCP uses its own bundled Chromium (installed below).
    # No need for standalone Firefox or Chromium packages.
    # =========================================================================
    \
    # =========================================================================
    # Node.js 20 LTS
    # =========================================================================
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    # =========================================================================
    # Playwright MCP + bundled Chromium
    # =========================================================================
    && npm install -g @playwright/mcp@0.0.68 tmux-mcp mcp-neovim-server \
    && mkdir -p ${PLAYWRIGHT_BROWSERS_PATH} \
    && node /usr/lib/node_modules/@playwright/mcp/node_modules/playwright/cli.js install --with-deps chromium \
    && CHROME_BIN="$(find ${PLAYWRIGHT_BROWSERS_PATH} -path '*/chrome-linux64/chrome' | head -n1)" \
    && if [ -n "$CHROME_BIN" ]; then \
         ln -sf "$CHROME_BIN" /usr/bin/chromium; \
         ln -sf /usr/bin/chromium /usr/bin/chromium-browser; \
       fi \
    # Cleanup
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

ENV LANG=en_US.UTF-8 \
    LC_ALL=en_US.UTF-8

# =============================================================================
# Non-root user (passwordless sudo)
# =============================================================================
RUN useradd -m -s /bin/bash -d /home/agenc agenc \
    && echo 'agenc ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/agenc \
    && chmod 0440 /etc/sudoers.d/agenc

# =============================================================================
# Branding: wallpaper + icon
# =============================================================================
COPY branding/wallpaper.svg /tmp/agenc-wallpaper.svg
COPY branding/agenc-logo.svg /usr/share/icons/hicolor/scalable/apps/agenc-logo.svg
# Rasterize wallpaper SVG to PNG (XFCE SVG rendering is unreliable on Xvfb)
RUN rsvg-convert -w 1920 -h 1080 /tmp/agenc-wallpaper.svg -o /usr/share/backgrounds/agenc-wallpaper.png \
    && rm /tmp/agenc-wallpaper.svg \
    && chmod 644 /usr/share/backgrounds/agenc-wallpaper.png \
    && chmod 644 /usr/share/icons/hicolor/scalable/apps/agenc-logo.svg \
    && (gtk-update-icon-cache /usr/share/icons/hicolor/ 2>/dev/null || true)

# Chromium wrapper: force no-sandbox inside containerized desktop.
RUN printf '%s\n' \
    '#!/usr/bin/env bash' \
    'set -euo pipefail' \
    '' \
    'CHROME_BIN="$(find /home/agenc/.cache/ms-playwright -path '\''*/chrome-linux64/chrome'\'' | head -n1 || true)"' \
    'if [ -z "${CHROME_BIN}" ]; then' \
    '  echo "chromium-wrapper: Chrome binary not found under /home/agenc/.cache/ms-playwright" >&2' \
    '  exit 1' \
    'fi' \
    '' \
    'has_no_sandbox=0' \
    'for arg in "$@"; do' \
    '  [ "$arg" = "--no-sandbox" ] && has_no_sandbox=1' \
    'done' \
    '' \
    'extra=()' \
    '[ "$has_no_sandbox" -eq 0 ] && extra+=(--no-sandbox)' \
    'extra+=(--disable-gpu --use-gl=swiftshader --disable-dev-shm-usage)' \
    '' \
    'exec "${CHROME_BIN}" "${extra[@]}" "$@"' \
    > /usr/local/bin/chromium-wrapper

RUN chmod +x /usr/local/bin/chromium-wrapper \
    && ln -sf /usr/local/bin/chromium-wrapper /usr/bin/chromium \
    && ln -sf /usr/local/bin/chromium-wrapper /usr/bin/chromium-browser

# =============================================================================
# XFCE configuration (dark theme, branded wallpaper, clean panel, no screensaver)
# =============================================================================
COPY xfce-config/xfce4-desktop.xml /home/agenc/.config/xfce4/xfconf/xfce-perchannel-xml/
COPY xfce-config/xfce4-power-manager.xml /home/agenc/.config/xfce4/xfconf/xfce-perchannel-xml/
COPY xfce-config/xfce4-screensaver.xml /home/agenc/.config/xfce4/xfconf/xfce-perchannel-xml/
COPY xfce-config/xfce4-session.xml /home/agenc/.config/xfce4/xfconf/xfce-perchannel-xml/
COPY xfce-config/xsettings.xml /home/agenc/.config/xfce4/xfconf/xfce-perchannel-xml/
COPY xfce-config/xfwm4.xml /home/agenc/.config/xfce4/xfconf/xfce-perchannel-xml/
COPY xfce-config/xfce4-panel.xml /home/agenc/.config/xfce4/xfconf/xfce-perchannel-xml/

# Terminal config (dark theme, JetBrains Mono, Tokyo Night palette)
COPY xfce-config/xfce4-terminal/ /home/agenc/.config/xfce4/terminal/

# =============================================================================
# Shell configuration (nice prompt, aliases)
# =============================================================================
RUN echo '\n\
# AgenC Desktop Environment\n\
export PS1="\\[\\033[38;5;105m\\]agenc\\[\\033[0m\\]@\\[\\033[38;5;243m\\]desktop\\[\\033[0m\\]:\\[\\033[38;5;75m\\]\\w\\[\\033[0m\\]\\$ "\n\
alias ll="ls -lah --color=auto"\n\
alias la="ls -A --color=auto"\n\
alias l="ls -CF --color=auto"\n\
alias grep="grep --color=auto"\n\
alias ..="cd .."\n\
alias ...="cd ../.."\n\
export EDITOR=nvim\n\
export TERM=xterm-256color\n\
' >> /home/agenc/.bashrc

# Vim config (sensible defaults)
RUN echo '\
set number\n\
set relativenumber\n\
set tabstop=4\n\
set shiftwidth=4\n\
set expandtab\n\
set autoindent\n\
set smartindent\n\
set hlsearch\n\
set incsearch\n\
set ignorecase\n\
set smartcase\n\
set wildmenu\n\
set scrolloff=8\n\
set sidescrolloff=8\n\
set signcolumn=yes\n\
set termguicolors\n\
set background=dark\n\
syntax on\n\
filetype plugin indent on\n\
' > /home/agenc/.vimrc

# Tmux config (dark, clean status bar)
RUN echo '\
set -g default-terminal "xterm-256color"\n\
set -g mouse on\n\
set -g history-limit 50000\n\
set -g base-index 1\n\
setw -g pane-base-index 1\n\
set -g status-style "bg=#0a0a0f,fg=#818cf8"\n\
set -g status-left "#[fg=#0a0a0f,bg=#818cf8,bold] #S #[fg=#818cf8,bg=#0a0a0f] "\n\
set -g status-right "#[fg=#414868] %H:%M "\n\
set -g window-status-current-format "#[fg=#0a0a0f,bg=#818cf8,bold] #I:#W "\n\
set -g window-status-format " #[fg=#414868]#I:#W "\n\
set -g pane-border-style "fg=#1a1b26"\n\
set -g pane-active-border-style "fg=#818cf8"\n\
' > /home/agenc/.tmux.conf

# =============================================================================
# Supervisor configuration
# =============================================================================
COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf
RUN chmod 644 /etc/supervisor/conf.d/supervisord.conf

# =============================================================================
# REST server
# =============================================================================
COPY server/package.json server/package-lock.json* /opt/server/
WORKDIR /opt/server
RUN npm install --production

COPY server/dist/ /opt/server/dist/

# =============================================================================
# Fix ownership
# =============================================================================
RUN chown -R agenc:agenc /home/agenc /opt/server /tmp

USER agenc
WORKDIR /home/agenc

# Ports: VNC (5900), noVNC (6080), REST API (9990)
EXPOSE 5900 6080 9990

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -sf http://localhost:9990/health || exit 1

CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
