const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors({
    origin: "*"
}));

app.use(express.json());

let latestMessage = "No Message";

app.post("/send", (req, res) => {

    latestMessage = req.body.message;

    console.log("Received:", latestMessage);

    res.json({
        status: "Message Stored"
    });
});

app.get("/message", (req, res) => {

    res.json({
        message: latestMessage
    });
});

const PORT = 3000;

app.listen(PORT, () => {

    console.log(`Server Running On ${PORT}`);
});