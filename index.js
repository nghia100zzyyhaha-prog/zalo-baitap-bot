import dns from "dns";
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import { MongoClient } from "mongodb";
import { Zalo, ThreadType } from "zca-js";

// Ép Node.js dùng DNS Google & Cloudflare để sửa lỗi querySrv ECONNREFUSED
dns.setServers(["8.8.8.8", "1.1.1.1"]);

// Tự động nạp file .env nếu chạy trên máy tính cá nhân
if (fs.existsSync(".env")) {
    for (const line of fs.readFileSync(".env", "utf-8").split(/\r?\n/)) {
        const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
        if (match && !process.env[match[1]]) {
            process.env[match[1]] = (match[2] || "").replace(/^['"]|['"]$/g, "").trim();
        }
    }
}

const SESSION_FILE = "./session.json";
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || "";
const STORAGE_GROUP_ID = process.env.STORAGE_GROUP_ID || "";

// 1. Mở cổng HTTP để Render và UptimeRobot giữ bot thức 24/7
http
    .createServer((req, res) => {
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Zalo Group Bot dang hoat dong 24/7!");
    })
    .listen(PORT, () => {
        console.log(`🌐 Web server keep-alive đang chạy tại cổng ${PORT}`);
    });

// 2. Kết nối cơ sở dữ liệu đám mây MongoDB Atlas
let groupsCollection = null;
async function initDatabase() {
    if (!MONGODB_URI) {
        throw new Error("Thiếu biến môi trường MONGODB_URI!");
    }
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    const db = client.db("zalo_baitap_bot");
    groupsCollection = db.collection("groups");
    console.log("🗄️ Đã kết nối MongoDB Atlas thành công!");
}

async function getGroupData(threadId) {
    let doc = await groupsCollection.findOne({ _id: threadId });
    if (!doc) {
        doc = { _id: threadId, activeId: null, assignments: {} };
        await groupsCollection.insertOne(doc);
    }
    return doc;
}

async function saveGroupData(threadId, groupData) {
    await groupsCollection.updateOne(
        { _id: threadId },
        { $set: { activeId: groupData.activeId, assignments: groupData.assignments } },
        { upsert: true }
    );
}

// 3. Hàm đọc kích thước ảnh bắt buộc cho zca-js
async function imageMetadataGetter(filePath) {
    const size = fs.statSync(filePath).size;
    const buf = fs.readFileSync(filePath);

    if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
        return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), size };
    }
    if (buf.length >= 10 && buf.toString("ascii", 0, 3) === "GIF") {
        return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), size };
    }
    if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
        let i = 2;
        while (i < buf.length) {
            if (buf[i] !== 0xff) break;
            const marker = buf[i + 1];
            i += 2;
            if (
                (marker >= 0xc0 && marker <= 0xc3) ||
                (marker >= 0xc5 && marker <= 0xc7) ||
                (marker >= 0xc9 && marker <= 0xcb) ||
                (marker >= 0xcd && marker <= 0xcf)
            ) {
                return { height: buf.readUInt16BE(i + 3), width: buf.readUInt16BE(i + 5), size };
            }
            if (
                marker === 0xd8 ||
                marker === 0xd9 ||
                (marker >= 0xd0 && marker <= 0xd7) ||
                marker === 0x01
            ) {
                continue;
            }
            if (i + 2 > buf.length) break;
            i += buf.readUInt16BE(i);
        }
    }
    return { width: 1280, height: 720, size };
}

const zalo = new Zalo({
    selfListen: true,
    checkUpdate: false,
    imageMetadataGetter,
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pendingSubmissions = new Map();

function getMediaIcon(type) {
    if (type === "video") return "🎬";
    if (type === "file") return "📄";
    return "🖼️";
}

async function downloadToTemp(url, ext) {
    const res = await fetch(url, {
        headers: {
            "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        },
    });
    if (!res.ok) throw new Error(`Tải file thất bại (HTTP ${res.status})`);
    const buffer = Buffer.from(await res.arrayBuffer());
    const tmpPath = path.join(
        os.tmpdir(),
        `zalo_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.${ext}`
    );
    fs.writeFileSync(tmpPath, buffer);
    return tmpPath;
}

function extractMediaInfo(message) {
    const msgType = (message.data?.msgType || "").toLowerCase();
    const content = message.data?.content;

    if (!content || typeof content !== "object") return null;

    let parsedParams = {};
    if (content.params) {
        try {
            parsedParams =
                typeof content.params === "string" ? JSON.parse(content.params) : content.params;
        } catch { }
    }

    const isFile =
        msgType.includes("file") || Boolean(parsedParams.fileExt || parsedParams.checksum);

    const isVideo =
        !isFile &&
        (msgType.includes("video") ||
            Boolean(parsedParams.videoUrl) ||
            (typeof content.href === "string" && content.href.includes(".mp4")));

    const isPhoto =
        !isFile &&
        !isVideo &&
        (msgType.includes("photo") ||
            msgType.includes("image") ||
            Boolean(
                content.href || content.thumb || parsedParams.hd || parsedParams.ori || parsedParams.normal
            ));

    if (!isFile && !isVideo && !isPhoto) return null;

    const caption = isFile
        ? (content.description || parsedParams.description || "").trim()
        : (
            content.title ||
            content.description ||
            parsedParams.title ||
            parsedParams.description ||
            ""
        ).trim();

    const mediaUrl = isFile
        ? content.href || parsedParams.href || parsedParams.url || ""
        : parsedParams.hd ||
        parsedParams.ori ||
        parsedParams.videoUrl ||
        parsedParams.normal ||
        content.href ||
        content.thumb ||
        "";

    if (!mediaUrl) return null;

    let type = isVideo ? "video" : "photo";
    let ext = isVideo ? "mp4" : "jpg";

    if (isFile) {
        type = "file";
        const rawTitle = content.title || "";
        const titleExt = rawTitle.includes(".") ? rawTitle.split(".").pop() : "";
        ext = (parsedParams.fileExt || titleExt || "bin")
            .toLowerCase()
            .replace(/[^a-z0-9]/g, "");
    }

    return { type, ext, url: mediaUrl, caption };
}

function isValidStudentName(name, mode) {
    const clean = name.trim();
    if (!clean || clean.startsWith("/")) return false;
    if (/^(📝|✅|❌|📋|📂|⚠️|🎉|🛑|🖼️|🎬|📄|🆔)/.test(clean)) return false;

    if (mode === "sothututen") {
        return /^\d+[\s.\-_:]+.+/.test(clean);
    }
    return clean.length >= 2;
}

async function startBot() {
    await initDatabase();

    let api;
    if (process.env.ZALO_SESSION) {
        const savedSession = JSON.parse(process.env.ZALO_SESSION.trim());
        api = await zalo.login(savedSession);
        console.log("✅ Đã đăng nhập bằng biến môi trường ZALO_SESSION!");
    } else if (fs.existsSync(SESSION_FILE)) {
        const savedSession = JSON.parse(fs.readFileSync(SESSION_FILE, "utf-8"));
        api = await zalo.login(savedSession);
        console.log("✅ Đã đăng nhập bằng file session.json!");
    } else {
        api = await zalo.loginQR({ qrPath: "./qr.png" });
    }

    api.listener.on("message", async (message) => {
        if (message.type !== ThreadType.Group) return;

        const threadId = message.threadId;
        const senderId = message.data?.uidFrom || "unknown";
        const rawContent = message.data?.content;
        const text = typeof rawContent === "string" ? rawContent.trim() : "";

        try {
            // Lệnh phụ trợ: Lấy ID nhóm để cài biến STORAGE_GROUP_ID (chỉ acc bot dùng được)
            if (text === "/getid") {
                if (!message.isSelf) return;
                await api.sendMessage(`🆔 ID của nhóm này là: ${threadId}`, threadId, ThreadType.Group);
                return;
            }

            // Bỏ qua các tin nhắn bên trong chính nhóm Kho Lưu Trữ
            if (STORAGE_GROUP_ID && threadId === STORAGE_GROUP_ID) return;

            const groupData = await getGroupData(threadId);

            // =================================================================
            // 1. LỆNH /taobaitap (CHỈ ACC BOT MỚI ĐƯỢC NHẬP)
            // =================================================================
            if (text.startsWith("/taobaitap")) {
                if (!message.isSelf) return;

                const parts = text.split(/\s+/);
                const mode = (parts[1] || "").toLowerCase();
                const taskId = parts.slice(2).join("_").trim();

                if (mode === "yeucau") return;

                if (!["hovaten", "sothututen"].includes(mode) || !taskId) {
                    await sleep(800);
                    await api.sendMessage(
                        "⚠️ Sai cú pháp rồi! Hãy nhập đúng mẫu:\n" +
                        "👉 /taobaitap hovaten [số bài tập]\n" +
                        "👉 /taobaitap sothututen [số bài tập]",
                        threadId,
                        ThreadType.Group
                    );
                    return;
                }

                groupData.activeId = taskId;
                groupData.assignments[taskId] = {
                    id: taskId,
                    mode,
                    status: "active",
                    createdAt: Date.now(),
                    submissions: [],
                };
                await saveGroupData(threadId, groupData);
                pendingSubmissions.clear();

                const modeDesc =
                    mode === "hovaten"
                        ? "✍️ Gửi ảnh/video/file kèm Họ và Tên (VD: Nguyễn Văn A)"
                        : "🔢 Gửi ảnh/video/file kèm Số thứ tự + Tên (VD: 12 Nguyễn Văn A)";

                await sleep(800);
                await api.sendMessage(
                    `📝 ĐÃ MỞ THU BÀI TẬP SỐ: ${taskId}\n` +
                    `📌 Yêu cầu: ${modeDesc}\n` +
                    `💡 Mẹo: Có thể gửi ảnh/video/file xong nhắn tên ngay sau đó đều được tính!`,
                    threadId,
                    ThreadType.Group
                );
                return;
            }

            // =================================================================
            // 2. LỆNH /huybaitap (CHỈ ACC BOT MỚI ĐƯỢC NHẬP)
            // =================================================================
            if (text === "/huybaitap") {
                if (!message.isSelf) return;

                const currentId = groupData.activeId;
                if (!currentId || !groupData.assignments[currentId]) {
                    await sleep(800);
                    await api.sendMessage(
                        "❌ Hiện tại không có bài tập nào đang mở.",
                        threadId,
                        ThreadType.Group
                    );
                    return;
                }

                const task = groupData.assignments[currentId];
                task.status = "closed";
                task.closedAt = Date.now();
                groupData.activeId = null;
                await saveGroupData(threadId, groupData);
                pendingSubmissions.clear();

                let report = `🛑 ĐÃ KẾT THÚC BÀI TẬP [${currentId}]\n`;
                if (task.submissions.length === 0) {
                    report += "📭 Chưa có học sinh nào nộp bài.";
                } else {
                    report += `📋 Danh sách đã nộp (${task.submissions.length} bài):\n`;
                    task.submissions.forEach((sub, idx) => {
                        report += `${idx + 1}. ${getMediaIcon(sub.mediaType)} ${sub.studentName}\n`;
                    });
                }

                await sleep(800);
                await api.sendMessage(report.trim(), threadId, ThreadType.Group);
                return;
            }

            // =================================================================
            // 3. LỆNH /xembaitap hoặc /xembaitap <số bài tập>
            // =================================================================
            if (text === "/xembaitap" || text.startsWith("/xembaitap ")) {
                const argId = text.slice(10).trim().replace(/\s+/g, "_");
                let targetTask = null;

                if (argId) {
                    targetTask = groupData.assignments[argId];
                } else {
                    const closedTasks = Object.values(groupData.assignments)
                        .filter((t) => t.status === "closed")
                        .sort((a, b) => (b.closedAt || b.createdAt) - (a.closedAt || a.createdAt));
                    targetTask = closedTasks[0] || null;
                }

                if (!targetTask) {
                    await sleep(800);
                    await api.sendMessage(
                        argId
                            ? `❌ Không tìm thấy bài tập số [${argId}].`
                            : "📭 Chưa có bài tập nào đã kết thúc để xem lại.",
                        threadId,
                        ThreadType.Group
                    );
                    return;
                }

                if (targetTask.submissions.length === 0) {
                    await sleep(800);
                    await api.sendMessage(
                        `📭 Bài tập [${targetTask.id}] chưa có ai nộp bài.`,
                        threadId,
                        ThreadType.Group
                    );
                    return;
                }

                let summary = `📂 KẾT QUẢ BÀI TẬP [${targetTask.id}] (${targetTask.submissions.length} lượt nộp):\n`;
                targetTask.submissions.forEach((sub, idx) => {
                    summary += `${idx + 1}. ${getMediaIcon(sub.mediaType)} ${sub.studentName}\n`;
                });

                await sleep(800);
                await api.sendMessage(summary.trim(), threadId, ThreadType.Group);

                const BATCH_SIZE = 5;
                for (let i = 0; i < targetTask.submissions.length; i++) {
                    const sub = targetTask.submissions[i];
                    const ownerCaption = `${i + 1}. ${getMediaIcon(sub.mediaType)} ${sub.studentName}`;

                    await sleep(2500);
                    if (i > 0 && i % BATCH_SIZE === 0) {
                        await sleep(5000);
                    }

                    let tmpFile = null;
                    try {
                        tmpFile = await downloadToTemp(sub.mediaUrl, sub.ext || "jpg");
                        await api.sendMessage(
                            {
                                msg: ownerCaption,
                                attachments: [tmpFile],
                            },
                            threadId,
                            ThreadType.Group
                        );
                    } catch {
                        await api.sendMessage(
                            `${ownerCaption}\n🔗 Link bài làm: ${sub.mediaUrl}`,
                            threadId,
                            ThreadType.Group
                        );
                    } finally {
                        if (tmpFile && fs.existsSync(tmpFile)) {
                            fs.unlinkSync(tmpFile);
                        }
                    }
                }
                return;
            }

            // =================================================================
            // 4. THU BÀI TẬP TỰ ĐỘNG & SAO LƯU VÀO KHO ZALO RIÊNG
            // =================================================================
            if (groupData.activeId) {
                const currentTask = groupData.assignments[groupData.activeId];
                if (!currentTask || currentTask.status !== "active") return;

                const userKey = `${threadId}_${senderId}`;
                const now = Date.now();
                const media = extractMediaInfo(message);

                const finalizeSubmission = async (mediaObj, studentName) => {
                    const orderIndex = currentTask.submissions.length + 1;

                    if (STORAGE_GROUP_ID) {
                        let backupTmp = null;
                        try {
                            backupTmp = await downloadToTemp(mediaObj.url, mediaObj.ext);
                            await api.sendMessage(
                                {
                                    msg: `📦 [Bài ${currentTask.id}] #${orderIndex} - ${studentName}`,
                                    attachments: [backupTmp],
                                },
                                STORAGE_GROUP_ID,
                                ThreadType.Group
                            );
                        } catch (e) {
                            console.error("⚠️ Lỗi sao lưu sang nhóm kho:", e.message);
                        } finally {
                            if (backupTmp && fs.existsSync(backupTmp)) {
                                fs.unlinkSync(backupTmp);
                            }
                        }
                    }

                    currentTask.submissions.push({
                        studentName,
                        mediaUrl: mediaObj.url,
                        mediaType: mediaObj.type,
                        ext: mediaObj.ext,
                        submittedAt: Date.now(),
                    });
                    await saveGroupData(threadId, groupData);
                    pendingSubmissions.delete(userKey);

                    console.log(`✅ Đã lưu bài #${orderIndex} của ${studentName} lên Cloud`);
                    await sleep(1000);
                    await api.sendMessage(
                        `✅ Học sinh ${studentName} đã nộp bài vào ${currentTask.id}, Cảm ơn ! 🎉`,
                        threadId,
                        ThreadType.Group
                    );
                };

                if (media) {
                    if (media.caption && isValidStudentName(media.caption, currentTask.mode)) {
                        await finalizeSubmission(media, media.caption);
                        return;
                    }
                    const pending = pendingSubmissions.get(userKey);
                    if (pending && pending.text && now - pending.time < 60000) {
                        await finalizeSubmission(media, pending.text);
                        return;
                    }
                    pendingSubmissions.set(userKey, { media, text: null, time: now });
                    return;
                }

                if (text && isValidStudentName(text, currentTask.mode)) {
                    const pending = pendingSubmissions.get(userKey);
                    if (pending && pending.media && now - pending.time < 60000) {
                        await finalizeSubmission(pending.media, text);
                        return;
                    }
                    pendingSubmissions.set(userKey, { media: null, text, time: now });
                }
            }
        } catch (err) {
            console.error("❌ Lỗi xử lý:", err.message);
        }
    });

    api.listener.start();
    console.log("🚀 Bot thu bài tập 24/7 đã sẵn sàng hoạt động!");
}

startBot();