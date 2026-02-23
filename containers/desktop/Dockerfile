FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:1 \
    DISPLAY_WIDTH=1024 \
    DISPLAY_HEIGHT=768 \
    DISPLAY_DEPTH=24 \
    PORT=9990 \
    HOME=/home/agenc

# =============================================================================
# System packages
# =============================================================================
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Virtual display + desktop environment
    xvfb xfce4 xfce4-terminal xfce4-whiskermenu-plugin dbus-x11 \
    # File manager
    thunar \
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
    git vim tmux htop tree jq unzip \
    # Python
    python3 python3-pip python3-venv \
    # Misc utilities
    bash-completion locales software-properties-common \
    && locale-gen en_US.UTF-8 \
    # =========================================================================
    # Firefox (Mozilla PPA — snap doesn't work in Docker)
    # =========================================================================
    && add-apt-repository -y ppa:mozillateam/ppa \
    && printf 'Package: *\nPin: release o=LP-PPA-mozillateam\nPin-Priority: 1001\n' > /etc/apt/preferences.d/mozilla-firefox \
    && apt-get update \
    && apt-get install -y --no-install-recommends firefox \
    # =========================================================================
    # Chromium (chromium-team PPA — snap doesn't work in Docker)
    # =========================================================================
    && add-apt-repository -y ppa:saiarcot895/chromium-beta \
    && apt-get update \
    && apt-get install -y --no-install-recommends chromium-browser \
    # =========================================================================
    # Node.js 20 LTS
    # =========================================================================
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    # Cleanup
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

ENV LANG=en_US.UTF-8 \
    LC_ALL=en_US.UTF-8

# =============================================================================
# Non-root user (no sudo)
# =============================================================================
RUN useradd -m -s /bin/bash -d /home/agenc agenc

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
# Chromium defaults (no first-run, no crash report, dark mode)
# =============================================================================
RUN mkdir -p /home/agenc/.config/chromium/Default \
    && echo '{ "browser": { "has_seen_welcome_page": true, "check_default_browser": false }, "distribution": { "skip_first_run_ui": true, "suppress_first_run_default_browser_prompt": true } }' > /home/agenc/.config/chromium/Default/Preferences \
    && echo 'CHROMIUM_FLAGS="--no-first-run --disable-sync --disable-background-networking --no-default-browser-check"' > /home/agenc/.chromium-browser.init \
    # Firefox: disable first-run wizard and telemetry
    && mkdir -p /usr/lib/firefox/distribution \
    && echo '{"policies":{"DontCheckDefaultBrowser":true,"OverrideFirstRunPage":"","OverridePostUpdatePage":"","DisableTelemetry":true,"Preferences":{"datareporting.policy.dataSubmissionEnabled":{"Value":false},"browser.shell.checkDefaultBrowser":{"Value":false},"toolkit.telemetry.reportingpolicy.firstRun":{"Value":false},"browser.aboutwelcome.enabled":{"Value":false}}}}' > /usr/lib/firefox/distribution/policies.json

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
export EDITOR=vim\n\
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
