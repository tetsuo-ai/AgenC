FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:1 \
    DISPLAY_WIDTH=1024 \
    DISPLAY_HEIGHT=768 \
    DISPLAY_DEPTH=24 \
    PORT=9990 \
    HOME=/home/agenc

# System packages: display, desktop, VNC, input, screenshot, process mgmt, Node.js
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Virtual display + desktop
    xvfb xfce4 xfce4-terminal dbus-x11 \
    # VNC
    x11vnc novnc websockify \
    # Input automation
    xdotool xclip xsel \
    # Screenshot
    scrot imagemagick \
    # Process management
    supervisor \
    # Fonts
    fonts-liberation fonts-noto-color-emoji \
    # Networking/utils
    curl ca-certificates \
    # Node.js 20 LTS
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    # Cleanup
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

# Non-root user (no sudo)
RUN useradd -m -s /bin/bash -d /home/agenc agenc

# XFCE configuration (disable screensaver, power management, first-run wizard)
COPY xfce-config/ /home/agenc/.config/xfce4/xfconf/xfce-perchannel-xml/

# Supervisor configuration
COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf

# REST server
COPY server/package.json server/package-lock.json* /opt/server/
WORKDIR /opt/server
RUN npm install --production

COPY server/dist/ /opt/server/dist/

# Fix ownership
RUN chown -R agenc:agenc /home/agenc /opt/server /tmp

USER agenc

# Ports: VNC (5900), noVNC (6080), REST API (9990)
EXPOSE 5900 6080 9990

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -sf http://localhost:9990/health || exit 1

CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
