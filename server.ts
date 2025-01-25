import express from "express";
import http from "http";
import { Server } from "socket.io";
import Redis from "ioredis";
import "dotenv/config";
import { PrismaClient } from "@prisma/client";

declare global {
  var prisma: PrismaClient | undefined;
}

let prisma: PrismaClient;
if (process.env.NODE_ENV === "production") {
  prisma = new PrismaClient();
} else {
  if (!global.prisma) {
    global.prisma = new PrismaClient();
  }
  prisma = global.prisma;
}

const app = express();
const port = process.env.PORT || 5000;

const pub = new Redis({
  host: process.env.REDIS_HOST,
  port: parseInt(process.env.REDIS_PORT || "19672"),
  username: process.env.REDIS_USERNAME,
  password: process.env.REDIS_PASSWORD,
});
const sub = new Redis({
  host: process.env.REDIS_HOST,
  port: parseInt(process.env.REDIS_PORT || "19672"),
  username: process.env.REDIS_USERNAME,
  password: process.env.REDIS_PASSWORD,
});

app.use(express.json());

const saveMessageToDatabase = async (message: string) => {
  try {
    const parsedMessage = JSON.parse(message);
    const { msg, userID, fullName, avatar, questionId } = parsedMessage.message;

    await prisma.comment.create({
      data: {
        msg,
        userID,
        fullName,
        avatar,
        questionId,
      },
    });

    console.log("Message saved to database");
  } catch (error) {
    console.error("Error saving message to database:", error);
  }
};

setInterval(async () => {
    console.log("Fetching messages from Redis...");
    try {
        const messages = (await pub.lrange("MESSAGES", 0, -1)) || [];
  
      if (messages.length === 0) {
        console.log("No new messages.");
        return;
      }
  
      console.log(`Processing ${messages.length} messages...`);
      for (const message of messages) {
        try {
          await saveMessageToDatabase(message);
        } catch (err) {
          console.error("Failed to process message:", message);
          await pub.rpush("FAILED_MESSAGES", message);
        }
      }
  
      await pub.ltrim("MESSAGES", messages.length, -1);
      console.log("Processed messages removed from Redis queue.");
    } catch (err) {
      console.error("Error fetching messages from Redis:", err);
    }
  }, 10000);

const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
  },
});

sub.subscribe("MESSAGES");

io.on("connect", (socket) => {
  console.log(`New Socket Connected: ${socket.id}`);

  socket.on("event:message", async ({ message }: { message: any }) => {
    console.log(`Broadcasting to room: ${message.questionId}, message: ${message.msg}`);
    socket.to(message.questionId).emit("message", JSON.stringify({ message }));
    await pub.rpush("MESSAGES", JSON.stringify({ message }));
    await pub.publish("MESSAGES", JSON.stringify({ message }));
  });

  socket.on("join-room", (room) => {
    socket.join(room);
    console.log(`User joined room ${room}`);
    console.log("Rooms: ",  Array.from(socket.rooms));
  });

  socket.on("leave-room", (room) => {
    socket.leave(room);
    console.log(`User ${socket.id} left room ${room}`);
  });
});

sub.on("message", async (channel, message) => {
  if (channel === "MESSAGES") {
    const parsedMessage = JSON.parse(message);
    const { msg, userID, fullName, avatar, questionId } = parsedMessage.message;
    io.emit("message", message);
  }
});

// Start the server
httpServer.listen(port, () => {
  console.log(`> Server ready on http://localhost:${port}`);
});
