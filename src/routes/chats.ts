import { Router } from "express";
import type { Response } from "express";
import { prisma } from "../config/prisma.js";
import { authenticateToken, type AuthRequest } from "../middleware/auth.js";

const router = Router();

// GET /chats - Get all chats for current user
router.get("/", authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });

    const chats = await prisma.chat.findMany({
      where: {
        members: {
          some: { userId: req.user.id }
        }
      },
      include: {
        members: {
          include: {
            user: {
              select: { id: true, username: true, uniqueId: true, avatarUrl: true }
            }
          }
        },
        messages: {
          orderBy: { createdAt: "desc" },
          take: 1
        },
        group: {
          select: { name: true }
        }
      },
      orderBy: { updatedAt: "desc" }
    });

    return res.json(chats);
  } catch (err) {
    console.error("GET /chats error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// POST /chats - Create a direct chat with a uniqueId
router.post("/", authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    const { uniqueId } = req.body;
    
    if (!uniqueId) return res.status(400).json({ error: "uniqueId required" });

    const targetUser = await prisma.user.findUnique({
      where: { uniqueId }
    });

    if (!targetUser) return res.status(404).json({ error: "User not found" });

    // Check if chat already exists
    const existingChat = await prisma.chat.findFirst({
      where: {
        type: "DIRECT",
        AND: [
          { members: { some: { userId: req.user.id } } },
          { members: { some: { userId: targetUser.id } } }
        ]
      },
      include: {
        members: {
          include: {
            user: {
              select: { id: true, username: true, uniqueId: true, avatarUrl: true }
            }
          }
        }
      }
    });

    if (existingChat) {
      return res.json(existingChat);
    }

    // Create new chat
    const newChat = await prisma.chat.create({
      data: {
        type: "DIRECT",
        members: {
          create: [
            { userId: req.user.id },
            { userId: targetUser.id }
          ]
        }
      },
      include: {
        members: {
          include: {
            user: {
              select: { id: true, username: true, uniqueId: true, avatarUrl: true }
            }
          }
        }
      }
    });

    return res.json(newChat);
  } catch (err) {
    console.error("POST /chats error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// GET /chats/group/:groupId - Get or create group chat
router.get("/group/:groupId", authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    const groupId = parseInt(req.params.groupId as string);
    if (isNaN(groupId)) return res.status(400).json({ error: "Invalid groupId" });

    // Check if user is a member or owner of this group
    const group = await prisma.group.findUnique({
      where: { id: groupId },
      include: {
        members: { select: { userId: true } },
        chat: true,
      },
    });

    if (!group) return res.status(404).json({ error: "Group not found" });

    const isMember = group.ownerId === req.user.id ||
      group.members.some((m) => m.userId === req.user.id);
    if (!isMember) return res.status(403).json({ error: "Not a group member" });

    // Find or create group chat
    let chat = group.chat;
    if (!chat) {
      // Get all group member IDs (owner + members)
      const memberIds = [
        group.ownerId,
        ...group.members.map((m) => m.userId).filter((id) => id !== group.ownerId),
      ];
      chat = await prisma.chat.create({
        data: {
          type: "GROUP",
          groupId,
          members: {
            create: memberIds.map((userId) => ({ userId })),
          },
        },
      });
    } else {
      // Ensure current user is in the chat members
      const existing = await prisma.chatMember.findUnique({
        where: { chatId_userId: { chatId: chat.id, userId: req.user.id } },
      });
      if (!existing) {
        await prisma.chatMember.create({
          data: { chatId: chat.id, userId: req.user.id },
        });
      }
    }

    return res.json({ chatId: chat.id, groupName: group.name });
  } catch (err) {
    console.error("GET /chats/group/:groupId error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});


router.get("/details/:id", authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    const chatId = parseInt(req.params.id as string);
    if (isNaN(chatId)) return res.status(400).json({ error: "Invalid chat ID" });

    const chat = await prisma.chat.findUnique({
      where: { id: chatId },
      include: {
        members: {
          include: {
            user: {
              select: { id: true, username: true, uniqueId: true, avatarUrl: true }
            }
          }
        },
        group: true
      }
    });

    if (!chat) return res.status(404).json({ error: "Chat not found" });

    // Verify membership
    const isMember = chat.members.some(m => m.userId === req.user!.id);
    if (!isMember) return res.status(403).json({ error: "Access denied" });

    return res.json(chat);
  } catch (err) {
    console.error("GET /chats/:id error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// GET /chats/:id/messages
router.get("/:id/messages", authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    const chatId = parseInt(req.params.id as string);
    if (isNaN(chatId)) {
      return res.status(400).json({ error: "Invalid chat ID" });
    }

    // Verify membership
    const membership = await prisma.chatMember.findUnique({
      where: {
        chatId_userId: {
          chatId,
          userId: req.user.id
        }
      }
    });

    if (!membership) return res.status(403).json({ error: "Not a member of this chat" });

    const messages = await prisma.message.findMany({
      where: { chatId },
      orderBy: { createdAt: "asc" },
      include: {
        sender: {
          select: { id: true, username: true, uniqueId: true, avatarUrl: true }
        },
        replyTo: {
          include: {
            sender: {
              select: { id: true, username: true }
            }
          }
        },
        forwardFrom: {
          select: { id: true, username: true }
        }
      }
    });

    return res.json(messages);
  } catch (err) {
    console.error("GET /chats/messages error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// POST /chats/:id/messages
router.post("/:id/messages", authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    const chatId = parseInt(req.params.id as string);
    if (isNaN(chatId)) {
      return res.status(400).json({ error: "Invalid chat ID" });
    }
    const { content, replyToId, type, audioUrl } = req.body;

    if (!content && type !== "AUDIO") {
      return res.status(400).json({ error: "Message content or audio is required" });
    }

    // Verify membership
    const membership = await prisma.chatMember.findUnique({
      where: {
        chatId_userId: {
          chatId,
          userId: req.user.id
        }
      }
    });

    if (!membership) return res.status(403).json({ error: "Not a member of this chat" });

    const message = await prisma.message.create({
      data: {
        chatId,
        senderId: req.user.id,
        content: content || "",
        type: type || "TEXT",
        audioUrl: audioUrl || null,
        replyToId: replyToId ? Number(replyToId) : null,
        forwardFromId: req.body.forwardFromId ? Number(req.body.forwardFromId) : null
      },
      include: {
        sender: {
          select: { id: true, username: true, uniqueId: true, avatarUrl: true }
        },
        replyTo: {
          include: {
            sender: {
              select: { id: true, username: true }
            }
          }
        },
        forwardFrom: {
          select: { id: true, username: true }
        }
      }
    });

    // Update chat updatedAt
    await prisma.chat.update({
      where: { id: chatId },
      data: { updatedAt: new Date() }
    });

    // In a real app we'd emit via Socket.io or SSE here
    
    return res.json(message);
  } catch (err) {
    console.error("POST /chats/messages error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// PATCH /chats/messages/:messageId - Edit message
router.patch("/messages/:messageId", authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    const messageId = parseInt(req.params.messageId as string);
    const { content } = req.body;

    if (!content) return res.status(400).json({ error: "Content required" });

    const message = await prisma.message.findUnique({
      where: { id: messageId }
    });

    if (!message) return res.status(404).json({ error: "Message not found" });
    if (message.senderId !== req.user.id) return res.status(403).json({ error: "Forbidden" });

    const updated = await prisma.message.update({
      where: { id: messageId },
      data: { content, edited: true },
      include: {
        sender: {
          select: { id: true, username: true, uniqueId: true, avatarUrl: true }
        },
        replyTo: {
          include: {
            sender: {
              select: { id: true, username: true }
            }
          }
        },
        forwardFrom: {
          select: { id: true, username: true }
        }
      }
    });

    return res.json(updated);
  } catch (err) {
    console.error("PATCH /chats/messages error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// POST /chats/forward - Forward a message to a user by uniqueId
router.post("/forward", authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    const { messageId, targetUniqueId } = req.body;

    if (!messageId || !targetUniqueId) return res.status(400).json({ error: "messageId and targetUniqueId required" });

    // 1. Get original message
    const originalMsg = await prisma.message.findUnique({
      where: { id: messageId },
      include: { sender: true }
    });

    if (!originalMsg) return res.status(404).json({ error: "Original message not found" });

    // 2. Find target user
    const targetUser = await prisma.user.findUnique({
      where: { uniqueId: targetUniqueId }
    });

    if (!targetUser) return res.status(404).json({ error: "Target user not found" });

    // 3. Find/Create Chat
    let chat = await prisma.chat.findFirst({
      where: {
        type: "DIRECT",
        AND: [
          { members: { some: { userId: req.user.id } } },
          { members: { some: { userId: targetUser.id } } }
        ]
      }
    });

    if (!chat) {
      chat = await prisma.chat.create({
        data: {
          type: "DIRECT",
          members: {
            create: [{ userId: req.user.id }, { userId: targetUser.id }]
          }
        }
      });
    }

    // 4. Create Forwarded Message
    const forwardedMsg = await prisma.message.create({
      data: {
        chatId: chat.id,
        senderId: req.user.id,
        content: originalMsg.content,
        forwardFromId: originalMsg.forwardFromId || originalMsg.senderId // Keep original sender if already forwarded
      },
      include: {
        sender: { select: { id: true, username: true, uniqueId: true, avatarUrl: true } },
        forwardFrom: { select: { id: true, username: true } }
      }
    });

    return res.json(forwardedMsg);
  } catch (err) {
    console.error("POST /chats/forward error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// DELETE /chats/:id - Delete a chat
router.delete("/:id", authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    const { id } = req.params;

    // Check if user is member
    const membership = await prisma.chatMember.findFirst({
      where: { chatId: parseInt(id), userId: req.user.id }
    });

    if (!membership) return res.status(403).json({ error: "Forbidden" });

    await prisma.chat.delete({
      where: { id: parseInt(id) }
    });

    return res.json({ success: true });
  } catch (err) {
    console.error("DELETE /chats/:id error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// DELETE /chats/:id/messages - Clear messages
router.delete("/:id/messages", authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    const { id } = req.params;

    const membership = await prisma.chatMember.findFirst({
      where: { chatId: parseInt(id), userId: req.user.id }
    });

    if (!membership) return res.status(403).json({ error: "Forbidden" });

    await prisma.message.deleteMany({
      where: { chatId: parseInt(id) }
    });

    return res.json({ success: true });
  } catch (err) {
    console.error("DELETE /chats/:id/messages error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

export default router;
