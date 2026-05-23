const express = require("express");
const { exec } = require("child_process");
const { createProxyMiddleware } = require("http-proxy-middleware");

const app = express();

const PORT = 4000;

async function ensureContainerRunning(req, res, next) {

    exec(
        "docker ps -a --filter name=study-room-container --format '{{.Status}}'",
        (err, stdout, stderr) => {

            if (err) {
                return res.send("Error checking container.");
            }

            const status = stdout.toLowerCase();

            if (status.includes("exited")) {

                console.log("Container stopped. Starting...");

                exec("docker start study-room-container", (startErr) => {

                    if (startErr) {
                        return res.send("Failed to start container.");
                    }

                    console.log("Container started.");

                    setTimeout(next, 5000);
                });

            } else {
                next();
            }
        }
    );
}

app.use(
    "/",
    ensureContainerRunning,
    createProxyMiddleware({
        target: "http://app:5000",
        changeOrigin: true
    })
);

app.listen(PORT, () => {
    console.log(`Controller running on port ${PORT}`);
});