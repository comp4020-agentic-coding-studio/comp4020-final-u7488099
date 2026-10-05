import express from "express";
import { readFileSync } from "node:fs";
import { gather } from "./actions.ts";
import { getState } from "./state.ts";

const app = express();
app.use(express.json());
app.use(express.static("public"));
app.use(express.static("dist/client"));

app.get("/readme/", (_req, res) => {
  const readme = readFileSync("README.md", "utf8");
  const escaped = readme.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  res.type("html").send(`<!doctype html>
<html lang="en-AU">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>About</title>
  </head>
  <body>
    <main>
      <h1>About</h1>
      <pre>
${escaped}
      </pre>
    </main>
  </body>
</html>
`);
});

app.get("/api/state", (_req, res) => {
  res.json(getState());
});

app.post("/api/gather", (req, res) => {
  const { workerId, nodeId } = req.body ?? {};
  if (typeof workerId !== "number" || typeof nodeId !== "number") {
    res.status(400).json({ error: "workerId and nodeId are required" });
    return;
  }
  const result = gather(workerId, nodeId);
  if (!result.ok) {
    res.status(400).json(result);
    return;
  }
  res.json(getState());
});

const port = Number(process.env.PORT ?? 8080);
app.listen(port, "0.0.0.0", () => {
  console.log(`listening on http://0.0.0.0:${port}`);
});
