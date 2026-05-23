const axios = require("axios");
const { exec } = require("child_process");

const CHECK_INTERVAL = 30000; // 30 sec
const INACTIVITY_LIMIT = 60; // 1 min

async function checkServerActivity() {
    try {
        const response = await axios.get("http://app:5000/server-status");

        const inactiveTime = response.data.inactiveForSeconds;

        console.log(`Inactive for ${inactiveTime} seconds`);

        if (inactiveTime >= INACTIVITY_LIMIT) {
            console.log("No activity detected. Stopping container...");

            exec("docker stop study-room-container", (error, stdout, stderr) => {
                if (error) {
                    console.error(`Error stopping container: ${error.message}`);
                    return;
                }

                console.log(stdout);
            });
        }

    } catch (err) {
        console.error("Error checking activity:", err.message);
    }
}

setInterval(checkServerActivity, CHECK_INTERVAL);