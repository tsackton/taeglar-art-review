"use strict";

const http = require("node:http");
const {execFile} = require("node:child_process");
const {promisify} = require("node:util");
const {randomBytes} = require("node:crypto");
const {pathToFileURL} = require("node:url");
const path = require("node:path");
const syncArtReviews = require("./github-sync.js");
const {canonical} = require("./review-log.js");
const exec = promisify(execFile);
const repo = "repos/tsackton/taeglar-art-review";
const limit = 20 * 1024 * 1024;

// Only the shared sync routine constructs endpoints, methods, and Git commits.
// Authentication stays inside the GitHub CLI.
function ghRequest(endpoint, method = "GET", data) {
  const route = endpoint === "/graphql" ? "graphql" : repo + endpoint;
  const args = ["api","--hostname","github.com","--include","--method",method,route];
  if (data !== undefined) args.push("--input","-");
  return new Promise((resolve,reject) => {
    const child = execFile("gh",args,{timeout:90000,maxBuffer:64*1024*1024},(failure,stdout) => {
      const header = /^HTTP\/[\d.]+\s+(\d+)[^\n]*\n[\s\S]*?\r?\n\r?\n/.exec(stdout);
      if (!header) {
        const error = Error("GitHub CLI could not reach github.com. Check your connection and gh auth status.");
        error.status = 0;
        return reject(error);
      }
      try {
        const result = JSON.parse(stdout.slice(header[0].length) || "null");
        const status = Number(header[1]);
        if (failure || status < 200 || status >= 300) {
          const error = Error(result?.message || "GitHub CLI request failed.");
          error.status = status;
          throw error;
        }
        resolve(result);
      } catch (error) { reject(error); }
    });
    child.stdin.on("error",() => {}); // An early CLI exit is reported by the callback.
    child.stdin.end(data === undefined ? undefined : JSON.stringify(data));
  });
}

async function startBridge({request = ghRequest} = {}) {
  const key = randomBytes(32).toString("hex");
  const server = http.createServer(async (req,res) => {
    const send = (status,body) => {
      res.writeHead(status,{"Content-Type":"application/json","Cache-Control":"no-store"});
      res.end(JSON.stringify(body));
    };
    const origin = req.headers.origin;
    if (req.headers.host !== "127.0.0.1:" + server.address().port ||
        !["null","file://"].includes(origin) || req.url !== "/sync") return send(403,{error:"Unknown gallery connection."});
    res.setHeader("Access-Control-Allow-Origin",origin);
    if (req.method === "OPTIONS") {
      res.writeHead(204,{"Access-Control-Allow-Headers":"Content-Type, X-Review-Session","Access-Control-Allow-Methods":"POST","Access-Control-Allow-Private-Network":"true"});
      return res.end();
    }
    if (req.method !== "POST" || req.headers["x-review-session"] !== key) return send(403,{error:"Reopen the launcher to reconnect."});
    try {
      const chunks = [];
      let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > limit) return send(413,{error:"The review log exceeds the local sync request limit."});
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!Array.isArray(body.events) || typeof body.pullOnly !== "boolean") return send(400,{error:"Invalid review sync request."});
      const events = body.events.map(canonical);
      // Let the browser validate and save incoming entries BEFORE a push, even on a racing update.
      let incoming;
      const waitForBrowser = Error("Merge before pushing");
      try {
        const result = await syncArtReviews({authenticatedRequest:request,events,pullOnly:body.pullOnly,receive:fresh => {
          incoming = fresh.map(canonical);
          throw waitForBrowser;
        }});
        return send(200,{...result,events:[]});
      } catch (error) {
        if (error === waitForBrowser) return send(200,{events:incoming,pushed:0,pulled:incoming.length});
        throw error;
      }
    } catch (error) {
      send(400,{error:error.message});
    }
  });
  await new Promise((resolve,reject) => {
    server.once("error",reject);
    server.listen(0,"127.0.0.1",resolve);
  });
  return {server,port:server.address().port,key};
}

async function main() {
  const {stdout} = await exec("gh",["api","--hostname","github.com","user","--jq",".login"]);
  const {server,port,key} = await startBridge();
  const url = pathToFileURL(path.join(__dirname,"index.html"));
  url.hash = "gh-port=" + port + "&gh-key=" + key;
  try { await exec("/usr/bin/open",["-u",url.href]); }
  catch { server.close(); throw Error("Could not open the local gallery in your browser."); }
  console.log("Art review is connected through GitHub CLI as " + stdout.trim() + ".");
  console.log("Keep this window open while reviewing. Press Control-C to end the session.");
}

module.exports = {startBridge,ghRequest};
if (require.main === module) main().catch(error => {
  console.error("Could not start Art Review. " + error.message);
  process.exitCode = 1;
});
