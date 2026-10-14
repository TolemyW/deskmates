FROM mcr.microsoft.com/playwright:v1.58.2-noble
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb x11vnc novnc websockify xdotool imagemagick fluxbox \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN npm init -y >/dev/null && npm install playwright@1.58.2 @playwright/mcp @modelcontextprotocol/sdk >/dev/null 2>&1
COPY entry.sh /app/entry.sh
COPY test.mjs /app/test.mjs
RUN chmod +x /app/entry.sh
ENV DISPLAY=:99
CMD ["/app/entry.sh"]
