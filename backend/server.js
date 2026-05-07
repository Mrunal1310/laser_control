const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

let latestMessage = "No Message";

app.post("/send", (req, res) => {

    latestMessage = req.body.message;

    console.log("Received:", latestMessage);

    res.json({
        status: "OK"
    });
});

app.get("/message", (req, res) => {

    res.json({
        message: latestMessage
    });
});

app.listen(3000, () => {

    console.log("Server Running On Port 3000");
});