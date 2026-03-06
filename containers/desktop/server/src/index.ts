import { createDesktopServer } from "./server.js";

const PORT = parseInt(process.env.PORT ?? "9990", 10);
const authToken = process.env.DESKTOP_AUTH_TOKEN?.trim();
if (!authToken) {
  throw new Error("DESKTOP_AUTH_TOKEN must be set");
}

const server = createDesktopServer({ authToken });

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Desktop REST server listening on port ${PORT}`);
});
