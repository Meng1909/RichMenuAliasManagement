import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createWelcomeFlex } from "./flex-messages.ts";

declare const Deno: any;
const supabase = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
const LINE_API = "https://api.line.me/v2/bot";
const CHANNEL_ACCESS_TOKEN = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN");
const activeReplyTokens = new Map();

// Guarantee buckets exist
supabase.storage.createBucket('chat_attachments', { public: true }).then(() => console.log('Chat Bucket Checked')).catch(() => { });
supabase.storage.createBucket('richmenus', { public: true }).then(() => console.log('RichMenu Bucket Checked')).catch(() => { });

// Cache for Knowledge Base
let cachedKnowledgeUrl = "";
let cachedPdfBase64 = null;
let cachedDocContext = "";


// Form UI Helpers
function createFormFieldFlex(field, current, total) {
    const isSelect = field.type === 'select';
    let quickReplyItems = [];

    // 1. เพิ่มตัวเลือกจาก Field (ถ้าเป็น Select)
    if (isSelect && Array.isArray(field.options)) {
        field.options.forEach(opt => {
            quickReplyItems.push({
                type: "action",
                action: {
                    type: "message",
                    label: opt.substring(0, 20),
                    text: opt
                }
            });
        });
    }

    // 2. เพิ่มปุ่มควบคุมระบบ (ย้อนกลับ / ยกเลิก)
    if (current > 0) {
        quickReplyItems.push({
            type: "action",
            action: { type: "postback", label: "⏮️ ย้อนกลับ", data: "action=form_back" }
        });
    }
    
    quickReplyItems.push({
        type: "action",
        action: { type: "postback", label: "❌ ยกเลิก", data: "action=form_cancel" }
    });

    return {
        type: "flex",
        altText: `แบบฟอร์ม: ${field.label}`,
        contents: {
            type: "bubble",
            body: {
                type: "box",
                layout: "vertical",
                contents: [
                    { type: "text", text: `ขั้นตอนที่ ${current + 1}/${total}`, size: "xs", color: "#6366f1", weight: "bold" },
                    { type: "text", text: field.label, weight: "bold", size: "lg", margin: "md", wrap: true }
                ]
            }
        },
        quickReply: { items: quickReplyItems.slice(0, 13) } // LINE จำกัดที่ 13 ปุ่ม
    };
}

function createFormSuccessFlex(message) {
    return {
        type: "bubble",
        body: {
            type: "box",
            layout: "vertical",
            spacing: "md",
            contents: [
                { type: "text", text: "✅ บันทึกข้อมูลสำเร็จ", weight: "bold", color: "#10b981", size: "lg" },
                { type: "text", text: message, wrap: true, size: "sm", color: "#64748b" }
            ]
        }
    };
}

function createFormSummaryFlex(profile, responses, successMessage, formTitle = "สรุปข้อมูลการลงทะเบียน") {
    const summaryRows = responses.map(res => ({
        type: "box",
        layout: "vertical",
        margin: "md",
        contents: [
            { type: "text", text: res.form_fields?.label || "Question", size: "xs", color: "#9ca3af", weight: "bold" },
            { type: "text", text: res.response_value || "-", size: "sm", color: "#374151", wrap: true, weight: "bold", margin: "xs" }
        ]
    }));

    return {
        type: "bubble",
        header: {
            type: "box",
            layout: "vertical",
            backgroundColor: "#6366f1",
            contents: [
                { type: "text", text: "FORM SUBMITTED", color: "#ffffff", size: "xs", weight: "bold" },
                { type: "text", text: formTitle, color: "#ffffff", size: "lg", weight: "bold", margin: "xs", wrap: true }
            ]
        },
        body: {
            type: "box",
            layout: "vertical",
            spacing: "lg",
            contents: [
                {
                    type: "box",
                    layout: "horizontal",
                    spacing: "md",
                    contents: [
                        {
                            type: "box",
                            layout: "vertical",
                            width: "50px",
                            height: "50px",
                            cornerRadius: "25px",
                            contents: [{ type: "image", url: profile.pictureUrl || "https://cdn-icons-png.flaticon.com/512/149/149071.png", aspectMode: "cover", size: "full" }]
                        },
                        {
                            type: "box",
                            layout: "vertical",
                            contents: [
                                { type: "text", text: profile.displayName || "Unknown User", weight: "bold", size: "md", color: "#111827" },
                                { type: "text", text: "บันทึกข้อมูลเรียบร้อยแล้ว", size: "xs", color: "#10b981", weight: "bold" }
                            ]
                        }
                    ]
                },
                { type: "separator", margin: "xl" },
                {
                    type: "box",
                    layout: "vertical",
                    contents: summaryRows
                },
                { type: "separator", margin: "xl" },
                { type: "text", text: successMessage, size: "xs", color: "#6b7280", wrap: true, align: "center" }
            ]
        },
        styles: { header: { backgroundColor: "#6366f1" } }
    };
}

async function replyMessage(replyToken, messages) {
    const res = await fetch(`${LINE_API}/message/reply`, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${CHANNEL_ACCESS_TOKEN}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            replyToken,
            messages
        })
    });
    if (!res.ok) {
        const errorText = await res.text();
        console.error(`LINE API Error: ${res.status} -`, errorText, JSON.stringify(messages, null, 2));
    } else {
        let exhaustedUid = null;
        for (const [uid, data] of activeReplyTokens.entries()) {
            if (data.token === replyToken) {
                activeReplyTokens.delete(uid);
                exhaustedUid = uid;
                break;
            }
        }

        if (exhaustedUid) {
            supabase.from('system_settings').delete().eq('key', `rt_${exhaustedUid}`).then();


            const textSummary = messages.map((m: any) => {
                if (m.type === 'text') return m.text;
                if (m.type === 'image') return `[IMAGE] ${m.originalContentUrl}`;
                return `[${m.type.toUpperCase()}]`;
            }).join('\n');

            if (!textSummary.startsWith('[ADMIN:')) {
                supabase.from('chat_history').insert({ user_id: exhaustedUid, role: 'assistant', message: textSummary }).then();
            }
        }
    }
}
async function startLoadingIndicator(chatId, seconds = 3) {
    await fetch("https://api.line.me/v2/bot/chat/loading/start", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${CHANNEL_ACCESS_TOKEN}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            chatId,
            loadingSeconds: seconds > 5 ? 60 : seconds
        })
    });
}
// Webhook Server หลัก และ API Proxy สำหรับ Frontend
Deno.serve(async (req) => {
    const url = new URL(req.url);


    const headers = new Headers({
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS, PUT, DELETE, PATCH",
        "Access-Control-Allow-Headers": "*"
    });

    if (req.method === "OPTIONS") {
        return new Response(null, { headers, status: 204 });
    }


    const lineGroupPrefix = "/api/line/group/";
    if (url.pathname.includes(lineGroupPrefix)) {

        const pathAfterPrefix = url.pathname.substring(url.pathname.indexOf(lineGroupPrefix) + lineGroupPrefix.length);

        const pathParts = pathAfterPrefix.split("/").filter(Boolean);

        const groupId = pathParts[0];
        const action = pathParts[1];
        const subAction = pathParts[2];

        const h = Object.fromEntries(headers.entries());

        if (!groupId || !action) return new Response(JSON.stringify({ error: "Bad Request: Missing parameters" }), { status: 400, headers: { ...h, "Content-Type": "application/json" } });

        if (req.method === "GET") {
            if (action === "summary") {
                const res = await fetch(`${LINE_API}/group/${groupId}/summary`, {
                    headers: { "Authorization": `Bearer ${CHANNEL_ACCESS_TOKEN}` }
                });
                return new Response(await res.text(), { headers: { ...h, "Content-Type": "application/json" }, status: res.status });
            } else if (action === "members" && subAction === "count") {
                const res = await fetch(`${LINE_API}/group/${groupId}/members/count`, {
                    headers: { "Authorization": `Bearer ${CHANNEL_ACCESS_TOKEN}` }
                });
                return new Response(await res.text(), { headers: { ...h, "Content-Type": "application/json" }, status: res.status });
            } else if (action === "members" && subAction === "ids") {

                const { data: members, error } = await supabase.from('group_members').select('user_id').eq('group_id', groupId);
                if (error) {
                    return new Response(JSON.stringify({ error: error.message }), { headers: { ...h, "Content-Type": "application/json" }, status: 500 });
                }
                const memberIds = members.map(m => m.user_id);
                return new Response(JSON.stringify({ memberIds }), { headers: { ...h, "Content-Type": "application/json" }, status: 200 });
            } else if (action === "member" && subAction) {
                const res = await fetch(`${LINE_API}/group/${groupId}/member/${subAction}`, {
                    headers: { "Authorization": `Bearer ${CHANNEL_ACCESS_TOKEN}` }
                });
                return new Response(await res.text(), { headers: { ...h, "Content-Type": "application/json" }, status: res.status });
            }
        } else if (req.method === "POST" && action === "leave") {
            const res = await fetch(`${LINE_API}/group/${groupId}/leave`, {
                method: "POST",
                headers: { "Authorization": `Bearer ${CHANNEL_ACCESS_TOKEN}` }
            });
            return new Response(JSON.stringify({ success: res.ok }), { headers: { ...h, "Content-Type": "application/json" }, status: res.status });
        }
        return new Response("Not Found", { status: 404, headers: h });
    }
    const adminChatPrefix = "/api/admin/chat/";
    if (url.pathname.includes(adminChatPrefix)) {
        const h = Object.fromEntries(headers.entries());
        if (req.method === "OPTIONS") return new Response(null, { headers: { ...h, "Access-Control-Allow-Origin": "*" }, status: 204 });

        const pathAfterPrefix = url.pathname.substring(url.pathname.indexOf(adminChatPrefix) + adminChatPrefix.length);
        const action = pathAfterPrefix.split("/").filter(Boolean)[0];

        if (req.method === "GET" && action === "quota") {
            const qRes = await fetch(`${LINE_API}/message/quota`, { headers: { "Authorization": `Bearer ${CHANNEL_ACCESS_TOKEN}` } });
            const cRes = await fetch(`${LINE_API}/message/quota/consumption`, { headers: { "Authorization": `Bearer ${CHANNEL_ACCESS_TOKEN}` } });
            let qData, cData;
            try { qData = await qRes.json(); } catch (e) { qData = {}; }
            try { cData = await cRes.json(); } catch (e) { cData = {}; }
            return new Response(JSON.stringify({ totalUsage: cData.totalUsage || 0, type: qData.type || "none", value: qData.value || 0 }), { headers: { ...h, "Content-Type": "application/json" }, status: 200 });
        } else if (req.method === "POST" && action === "upload") {
            const formData = await req.formData();
            const file = formData.get("file");
            if (!file || !(file instanceof File)) {
                return new Response(JSON.stringify({ error: "No file provided" }), { status: 400, headers: { ...h, "Content-Type": "application/json" } });
            }

            const fileExt = file.name.split('.').pop() || 'bin';
            const fileName = `${Date.now()}-${Math.random().toString(36).substring(7)}.${fileExt}`;
            const arrayBuffer = await file.arrayBuffer();

            const { error } = await supabase.storage.from('chat_attachments').upload(fileName, arrayBuffer, { contentType: file.type, upsert: false });
            if (error) {
                return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...h, "Content-Type": "application/json" } });
            }

            const { data: publicUrlData } = supabase.storage.from('chat_attachments').getPublicUrl(fileName);
            return new Response(JSON.stringify({ url: publicUrlData.publicUrl, type: file.type, size: file.size, name: file.name }), { headers: { ...h, "Content-Type": "application/json" }, status: 200 });
        } else if (req.method === "POST" && action === "send") {
            const body = await req.json();
            const { userId, text, messageType = "text", fileUrl, fileName, adminName = "Admin", adminPic = "" } = body;

            let messagePayload;
            if (messageType === 'image') {
                messagePayload = { type: 'image', originalContentUrl: fileUrl, previewImageUrl: fileUrl };
            } else if (messageType === 'file') {
                messagePayload = { type: 'text', text: `[ส่งไฟล์: ${fileName}]\n${fileUrl}` };
            } else {
                messagePayload = { type: 'text', text };
            }

            const adminPrefix = `[ADMIN:${adminName}|${adminPic}] `;
            const historyMsg = adminPrefix + (messageType === 'text' ? text : `[${messageType.toUpperCase()}] ${fileUrl}`);

            let tokenData = activeReplyTokens.get(userId);

            if (!tokenData) {
                const { data } = await supabase.from('system_settings').select('value').eq('key', `rt_${userId}`).maybeSingle();
                if (data && data.value) tokenData = data.value;
            }

            const now = Date.now();
            let sentVia = "push";
            let success = false;
            let errorMsg = null;

            if (tokenData && (now - tokenData.timestamp < 20 * 60 * 1000)) {
                const res = await fetch(`${LINE_API}/message/reply`, {
                    method: "POST",
                    headers: { "Authorization": `Bearer ${CHANNEL_ACCESS_TOKEN}`, "Content-Type": "application/json" },
                    body: JSON.stringify({ replyToken: tokenData.token, messages: [messagePayload] })
                });
                if (res.ok) {
                    success = true; sentVia = "reply";
                    activeReplyTokens.delete(userId);
                    await supabase.from('system_settings').delete().eq('key', `rt_${userId}`);
                } else if (res.status === 400) {
                    activeReplyTokens.delete(userId);
                    await supabase.from('system_settings').delete().eq('key', `rt_${userId}`);
                }
            }

            if (!success) {
                const res = await fetch(`${LINE_API}/message/push`, {
                    method: "POST",
                    headers: { "Authorization": `Bearer ${CHANNEL_ACCESS_TOKEN}`, "Content-Type": "application/json" },
                    body: JSON.stringify({ to: userId, messages: [messagePayload] })
                });
                if (res.ok) {
                    success = true; sentVia = "push";
                } else {
                    errorMsg = await res.text();
                }
            }

            if (success) {
                await supabase.from('chat_history').insert({ user_id: userId, role: 'assistant', message: historyMsg });
            }
            return new Response(JSON.stringify({ success, sentVia, error: errorMsg }), { headers: { ...h, "Content-Type": "application/json" }, status: success ? 200 : 500 });
        } else if (req.method === "GET" && action === "status") {
            const userId = url.searchParams.get("userId");
            let tokenData = activeReplyTokens.get(userId);

            if (!tokenData) {
                const { data } = await supabase.from('system_settings').select('value').eq('key', `rt_${userId}`).maybeSingle();
                if (data && data.value) tokenData = data.value;
            }

            const now = Date.now();
            let validForMinutes = 0;
            if (tokenData && (now - tokenData.timestamp < 20 * 60 * 1000)) {
                validForMinutes = Math.floor((20 * 60 * 1000 - (now - tokenData.timestamp)) / 60000);
            }
            return new Response(JSON.stringify({ hasValidReplyToken: validForMinutes > 0, validForMinutes }), { headers: { ...h, "Content-Type": "application/json" }, status: 200 });
        } else if (req.method === "POST" && action === "markRead") {
            const body = await req.json();
            if (body.userId) {
                await supabase.from('system_settings').upsert({ key: `chat_meta_${body.userId}`, value: { unread: false, adminName: body.adminName, timestamp: Date.now() } });
            }
            return new Response(JSON.stringify({ success: true }), { headers: { ...h, "Content-Type": "application/json" } });
        } else if (req.method === "POST" && action === "assign") {
            const body = await req.json();
            const { userId, assignToName, assignedByName, message, userName } = body;

            await supabase.from('system_settings').upsert({
                key: `chat_meta_${userId}`,
                value: {
                    unread: true,
                    adminName: assignToName,
                    assignedBy: assignedByName,
                    timestamp: Date.now()
                }
            });

            const sysMsg = `[ASSIGN] มอบหมายแชทให้: ${assignToName} ดูแลต่อ${message ? `\n(หมายเหตุ: ${message})` : ''}`;
            await supabase.from('chat_history').insert({ user_id: userId, role: 'assistant', message: `[ADMIN:${assignedByName}|] ${sysMsg}` });

            const tgMsg = `🔔 <b>แจ้งเตือนการโอนแชท!</b>\n\nโอนแชทของลูกค้า: <b>${userName || 'ลูกค้า'}</b>\nมอบหมายให้แอดมิน: <b>${assignToName}</b>\nโอนโดย: <i>${assignedByName}</i>${message ? `\n\n💬 <b>หมายเหตุแนบ:</b>\n${message}` : ''}\n\n👉 <i>กรุณาเข้าสู่ระบบหลังบ้านเพื่อตรวจสอบทันที</i>`;

            try {

                const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN");
                const TELEGRAM_CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID");
                if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
                    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: tgMsg, parse_mode: "HTML" })
                    });
                }
            } catch (e) { }

            return new Response(JSON.stringify({ success: true }), { headers: { ...h, "Content-Type": "application/json" } });
        }
        return new Response("Not Found", { status: 404, headers: h });
    }

    const adminRichMenuPrefix = "/api/admin/richmenus";
    if (url.pathname.includes(adminRichMenuPrefix)) {
        const h = Object.fromEntries(headers.entries());
        if (req.method === "OPTIONS") return new Response(null, { headers: { ...h, "Access-Control-Allow-Origin": "*" }, status: 204 });

        let action = 'sync';
        let richMenuId = null;
        let richMenuData = null;
        let imageData = null;
        let aliasId = null;

        try {
            const body = await req.json();
            if (body.action) action = body.action;
            if (body.richMenuId) richMenuId = body.richMenuId;
            if (body.richMenuData) richMenuData = body.richMenuData;
            if (body.imageData) imageData = body.imageData;
            if (body.aliasId) aliasId = body.aliasId;
        } catch (e) { }

        if (action === 'delete') {
            if (!richMenuId) return new Response(JSON.stringify({ error: 'Missing richMenuId' }), { status: 400, headers: { ...h, "Content-Type": "application/json" } });

            const response = await fetch(`${LINE_API}/richmenu/${richMenuId}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${CHANNEL_ACCESS_TOKEN}` }
            });

            if (!response.ok && response.status !== 404) {
                const errText = await response.text();
                return new Response(JSON.stringify({ error: errText }), { status: 500, headers: { ...h, "Content-Type": "application/json" } });
            }
            return new Response(JSON.stringify({ success: true, action: 'delete' }), { headers: { ...h, "Content-Type": "application/json" } });

        } else if (action === 'create') {
            if (!richMenuData) return new Response(JSON.stringify({ error: 'Missing richMenuData' }), { status: 400, headers: { ...h, "Content-Type": "application/json" } });

            const response = await fetch(`${LINE_API}/richmenu`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${CHANNEL_ACCESS_TOKEN}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(richMenuData)
            });

            const result = await response.json();
            if (!response.ok) {
                return new Response(JSON.stringify({ error: result.message || 'Create Failed' }), { status: response.status, headers: { ...h, "Content-Type": "application/json" } });
            }
            return new Response(JSON.stringify({ success: true, richMenuId: result.richMenuId }), { headers: { ...h, "Content-Type": "application/json" } });

        } else if (action === 'upload') {
            if (!richMenuId || !imageData) return new Response(JSON.stringify({ error: 'Missing richMenuId or imageData' }), { status: 400, headers: { ...h, "Content-Type": "application/json" } });

            // imageData is base64 string
            const binary = atob(imageData.split(',')[1] || imageData);
            const array = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) array[i] = binary.charCodeAt(i);

            const response = await fetch(`https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${CHANNEL_ACCESS_TOKEN}`,
                    'Content-Type': 'image/png'
                },
                body: array
            });

            if (!response.ok) {
                const errText = await response.text();
                return new Response(JSON.stringify({ error: errText }), { status: response.status, headers: { ...h, "Content-Type": "application/json" } });
            }
            return new Response(JSON.stringify({ success: true }), { headers: { ...h, "Content-Type": "application/json" } });

        } else if (action === 'setDefault') {
            if (!richMenuId) return new Response(JSON.stringify({ error: 'Missing richMenuId' }), { status: 400, headers: { ...h, "Content-Type": "application/json" } });

            const response = await fetch(`${LINE_API}/user/all/richmenu/${richMenuId}`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${CHANNEL_ACCESS_TOKEN}` }
            });

            if (!response.ok) {
                const errText = await response.text();
                return new Response(JSON.stringify({ error: errText }), { status: response.status, headers: { ...h, "Content-Type": "application/json" } });
            }
            return new Response(JSON.stringify({ success: true, action: 'setDefault' }), { headers: { ...h, "Content-Type": "application/json" } });

        } else if (action === 'createAlias') {
            if (!richMenuId || !aliasId) return new Response(JSON.stringify({ error: 'Missing richMenuId or aliasId' }), { status: 400, headers: { ...h, "Content-Type": "application/json" } });
            const response = await fetch(`${LINE_API}/richmenu/alias`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${CHANNEL_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ richMenuAliasId: aliasId, richMenuId: richMenuId })
            });
            if (!response.ok) {
                const result = await response.json();
                return new Response(JSON.stringify({ error: result.message || 'Create Alias Failed' }), { status: response.status, headers: { ...h, "Content-Type": "application/json" } });
            }
            return new Response(JSON.stringify({ success: true, aliasId: aliasId }), { headers: { ...h, "Content-Type": "application/json" } });

        } else if (action === 'deleteAlias') {
            if (!aliasId) return new Response(JSON.stringify({ error: 'Missing aliasId' }), { status: 400, headers: { ...h, "Content-Type": "application/json" } });
            const response = await fetch(`${LINE_API}/richmenu/alias/${aliasId}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${CHANNEL_ACCESS_TOKEN}` }
            });
            if (!response.ok) {
                const errText = await response.text();
                return new Response(JSON.stringify({ error: errText }), { status: response.status, headers: { ...h, "Content-Type": "application/json" } });
            }
            return new Response(JSON.stringify({ success: true }), { headers: { ...h, "Content-Type": "application/json" } });

        } else if (action === 'updateAlias') {
            if (!richMenuId || !aliasId) return new Response(JSON.stringify({ error: 'Missing richMenuId or aliasId' }), { status: 400, headers: { ...h, "Content-Type": "application/json" } });
            const response = await fetch(`${LINE_API}/richmenu/alias/${aliasId}`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${CHANNEL_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ richMenuId: richMenuId })
            });
            if (!response.ok) {
                const errText = await response.text();
                return new Response(JSON.stringify({ error: errText }), { status: response.status, headers: { ...h, "Content-Type": "application/json" } });
            }
            return new Response(JSON.stringify({ success: true }), { headers: { ...h, "Content-Type": "application/json" } });

        } else if (action === 'getAlias') {
            if (!aliasId) return new Response(JSON.stringify({ error: 'Missing aliasId' }), { status: 400, headers: { ...h, "Content-Type": "application/json" } });
            const response = await fetch(`${LINE_API}/richmenu/alias/${aliasId}`, {
                headers: { 'Authorization': `Bearer ${CHANNEL_ACCESS_TOKEN}` }
            });
            const result = await response.json();
            return new Response(JSON.stringify(result), { headers: { ...h, "Content-Type": "application/json" }, status: response.status });

        } else if (action === 'listAlias') {
            const response = await fetch(`${LINE_API}/richmenu/alias/list`, {
                headers: { 'Authorization': `Bearer ${CHANNEL_ACCESS_TOKEN}` }
            });
            const result = await response.json();
            return new Response(JSON.stringify(result), { headers: { ...h, "Content-Type": "application/json" }, status: response.status });

        } else if (action === 'sync') {
            const listResponse = await fetch(`${LINE_API}/richmenu/list`, {
                headers: { 'Authorization': `Bearer ${CHANNEL_ACCESS_TOKEN}` }
            });

            if (!listResponse.ok) {
                return new Response(JSON.stringify({ error: await listResponse.text() }), { status: 500, headers: { ...h, "Content-Type": "application/json" } });
            }

            const { richmenus } = await listResponse.json();
            const activeRichMenuIds = richmenus.map((m: any) => m.richMenuId);

            if (activeRichMenuIds.length > 0) {
                const idStringList = activeRichMenuIds.map((id: string) => `"${id}"`).join(',');
                await supabase.from('rich_menus').delete().not('rich_menu_id', 'in', `(${idStringList})`);
            } else {
                await supabase.from('rich_menus').delete().neq('id', 0);
            }

            const results = [];
            for (const menu of richmenus) {
                const richMenuId = menu.richMenuId;
                const name = menu.name;
                const description = menu.chatBarText || '';

                const contentResponse = await fetch(`https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`, {
                    headers: { 'Authorization': `Bearer ${CHANNEL_ACCESS_TOKEN}` }
                });

                let imageUrl = null;
                if (contentResponse.ok) {
                    const imageBlob = await contentResponse.blob();
                    const fileName = `${richMenuId}.png`;
                    const { error: uploadError } = await supabase.storage.from('richmenus').upload(fileName, imageBlob, { contentType: 'image/png', upsert: true });
                    if (!uploadError) {
                        const { data: publicUrlData } = supabase.storage.from('richmenus').getPublicUrl(fileName);
                        imageUrl = publicUrlData.publicUrl;
                    }
                }

                const payload: any = { rich_menu_id: richMenuId, name: name, description: description };
                if (imageUrl) payload.image_url = imageUrl;

                const { error: dbError } = await supabase.from('rich_menus').upsert(payload, { onConflict: 'rich_menu_id' });
                if (dbError) {
                    results.push({ id: richMenuId, status: 'failed_db', error: dbError });
                } else {
                    results.push({ id: richMenuId, status: 'success' });
                }
            }

            return new Response(JSON.stringify({ success: true, results, action: 'sync' }), { headers: { ...h, "Content-Type": "application/json" }, status: 200 });
        }
        return new Response("Not Found", { status: 404, headers: h });
    }

    const adminAudiencePrefix = "/api/admin/audience";
    if (url.pathname.includes(adminAudiencePrefix)) {
        const h = Object.fromEntries(headers.entries());
        if (req.method === "OPTIONS") return new Response(null, { headers: { ...h, "Access-Control-Allow-Origin": "*" }, status: 204 });

        const pathAfterPrefix = url.pathname.substring(url.pathname.indexOf(adminAudiencePrefix) + adminAudiencePrefix.length);
        const action = pathAfterPrefix.split("/").filter(Boolean)[0];

        if (req.method === "GET" && action === "list") {
            const res = await fetch(`${LINE_API}/audienceGroup/list`, {
                headers: { "Authorization": `Bearer ${CHANNEL_ACCESS_TOKEN}` }
            });
            const data = await res.json();
            return new Response(JSON.stringify(data), { headers: { ...h, "Content-Type": "application/json" }, status: res.status });

        } else if (req.method === "GET" && action === "get") {
            const groupId = url.searchParams.get("groupId");
            const res = await fetch(`${LINE_API}/audienceGroup/${groupId}`, {
                headers: { "Authorization": `Bearer ${CHANNEL_ACCESS_TOKEN}` }
            });
            const data = await res.json();
            return new Response(JSON.stringify(data), { headers: { ...h, "Content-Type": "application/json" }, status: res.status });

        } else if (req.method === "POST" && action === "create") {
            const { description, tagName } = await req.json();
            if (!description || !tagName) return new Response(JSON.stringify({ error: "Missing description or tagName" }), { status: 400, headers: h });

            const { data: tagUsers, error } = await supabase.from('user_tags').select('user_id').eq('tag_name', tagName);
            if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: h });
            if (!tagUsers || tagUsers.length === 0) return new Response(JSON.stringify({ error: "No users found with this tag" }), { status: 400, headers: h });

            const audiences = tagUsers.map((u: any) => ({ id: u.user_id }));

            const res = await fetch(`${LINE_API}/audienceGroup/upload`, {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${CHANNEL_ACCESS_TOKEN}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    description,
                    isIfaAudience: false,
                    audiences
                })
            });

            const result = await res.json();
            if (!res.ok) {
                return new Response(JSON.stringify({ error: result.message || "Create failed", details: result }), { headers: { ...h, "Content-Type": "application/json" }, status: res.status });
            }
            return new Response(JSON.stringify(result), { headers: { ...h, "Content-Type": "application/json" }, status: res.status });

        } else if (req.method === "POST" && action === "update") {
            const { audienceGroupId, tagName } = await req.json();
            if (!audienceGroupId || !tagName) return new Response(JSON.stringify({ error: "Missing audienceGroupId or tagName" }), { status: 400, headers: h });

            const { data: tagUsers, error } = await supabase.from('user_tags').select('user_id').eq('tag_name', tagName);
            if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: h });
            if (!tagUsers || tagUsers.length === 0) return new Response(JSON.stringify({ error: "No users found with this tag" }), { status: 400, headers: h });

            const audiences = tagUsers.map((u: any) => ({ id: u.user_id }));

            const res = await fetch(`${LINE_API}/audienceGroup/upload`, {
                method: "PUT",
                headers: {
                    "Authorization": `Bearer ${CHANNEL_ACCESS_TOKEN}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    audienceGroupId: Number(audienceGroupId),
                    audiences
                })
            });

            if (res.ok) {
                return new Response(JSON.stringify({ success: true }), { headers: { ...h, "Content-Type": "application/json" }, status: 200 });
            } else {
                const result = await res.json();
                return new Response(JSON.stringify({ error: result.message || "Update failed", details: result }), { headers: { ...h, "Content-Type": "application/json" }, status: res.status });
            }

        } else if (req.method === "DELETE" && action === "delete") {
            const groupId = url.searchParams.get("groupId");
            if (!groupId) return new Response(JSON.stringify({ error: "Missing groupId" }), { status: 400, headers: h });

            const res = await fetch(`${LINE_API}/audienceGroup/${groupId}`, {
                method: "DELETE",
                headers: { "Authorization": `Bearer ${CHANNEL_ACCESS_TOKEN}` }
            });

            if (res.ok) {
                return new Response(JSON.stringify({ success: true }), { headers: { ...h, "Content-Type": "application/json" }, status: 200 });
            } else {
                const errData = await res.json().catch(() => ({}));
                return new Response(JSON.stringify({ error: errData.message || "Delete failed", details: errData }), { headers: { ...h, "Content-Type": "application/json" }, status: res.status });
            }

        } else if (req.method === "POST" && action === "narrowcast") {
            const { audienceGroupId, messages } = await req.json();
            if (!messages || !Array.isArray(messages)) return new Response(JSON.stringify({ error: "Messages array is required" }), { status: 400, headers: h });

            const payload: any = {
                messages: messages.slice(0, 5) // LINE limit
            };

            if (audienceGroupId) {
                payload.recipient = {
                    type: "audience",
                    audienceGroupId: Number(audienceGroupId)
                };
            }

            const res = await fetch(`${LINE_API}/message/narrowcast`, {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${CHANNEL_ACCESS_TOKEN}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(payload)
            });

            const result = await res.json();
            
            // --- [LOGGING TO BROADCAST HISTORY] ---
            try {
                await supabase.from('broadcast_history').insert({
                    messages: messages,
                    target_type: audienceGroupId ? 'audience' : 'all',
                    target_id: audienceGroupId ? String(audienceGroupId) : null,
                    status: res.ok ? 'sent' : 'failed',
                    error_message: res.ok ? null : (result.message || JSON.stringify(result))
                });
            } catch (logErr) {
                console.error("Failed to log broadcast history:", logErr);
            }
            // --- [END LOGGING] ---

            if (!res.ok) {
                return new Response(JSON.stringify({ error: result.message || "Narrowcast failed", details: result }), { headers: { ...h, "Content-Type": "application/json" }, status: res.status });
            }
            return new Response(JSON.stringify(result), { headers: { ...h, "Content-Type": "application/json" }, status: res.status });
        }

        return new Response("Not Found", { status: 404, headers: h });
    }

    const adminUsersPrefix = "/api/admin/users";
    if (url.pathname.includes(adminUsersPrefix)) {
        const h = Object.fromEntries(headers.entries());
        if (req.method === "OPTIONS") return new Response(null, { headers: { ...h, "Access-Control-Allow-Origin": "*" }, status: 204 });

        const pathAfterPrefix = url.pathname.substring(url.pathname.indexOf(adminUsersPrefix) + adminUsersPrefix.length);
        const action = pathAfterPrefix.split("/").filter(Boolean)[0];

        if (req.method === "POST" && action === "updateProfile") {
            try {
                const { userId } = await req.json();
                if (!userId) return new Response(JSON.stringify({ error: "Missing userId" }), { status: 400, headers: h });

                const res = await fetch(`${LINE_API}/profile/${userId}`, {
                    headers: { "Authorization": `Bearer ${CHANNEL_ACCESS_TOKEN}` }
                });

                if (!res.ok) {
                    const errData = await res.json().catch(() => ({}));
                    return new Response(JSON.stringify({ error: errData.message || "Fetch profile failed from LINE API", details: errData }), { headers: { ...h, "Content-Type": "application/json" }, status: res.status });
                }

                const profile = await res.json();

                const { data, error } = await supabase.from('user_profiles').upsert({
                    userId: profile.userId,
                    displayName: profile.displayName,
                    pictureUrl: profile.pictureUrl,
                    statusMessage: profile.statusMessage,
                    updated_at: new Date().toISOString()
                }, { onConflict: 'userId' }).select();

                if (error) {
                    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...h, "Content-Type": "application/json" } });
                }

                return new Response(JSON.stringify({ success: true, profile: data[0] || profile }), { headers: { ...h, "Content-Type": "application/json" }, status: 200 });
            } catch (e: any) {
                return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...h, "Content-Type": "application/json" } });
            }
        }
        return new Response("Not Found", { status: 404, headers: h });
    }

    const standardHeader = Object.fromEntries(headers.entries());

    if (req.method !== "POST") {
        return new Response("Method Not Allowed", {
            status: 405,
            headers: standardHeader
        });
    }
    try {
        const body = await req.json();
        queueMicrotask(() => handleEvents(body.events));
        return new Response("OK", {
            headers: standardHeader,
            status: 200
        });
    } catch (e) {
        console.error(e);
        return new Response("Bad Request", {
            headers: standardHeader,
            status: 400
        });
    }
});
async function handleEvents(events: any) {
    for (const event of events) {
        const userId = event.source.userId;

        if (event.replyToken && userId) {
            activeReplyTokens.set(userId, { token: event.replyToken, timestamp: Date.now() });
            supabase.from('system_settings').upsert({ key: `rt_${userId}`, value: { token: event.replyToken, timestamp: Date.now() } }).then();
        }

        let isGlobalAiOn = true;
        let isUserAiOn = true;

        if (event.type === "message" || event.type === "postback") {
            try {

                const { data: userData } = await supabase
                    .from("user_profiles")
                    .select("status, ai_status")
                    .eq("userId", userId)
                    .maybeSingle();

                if (userData && userData.status === "block") {
                    console.log(`🚫 Blocked User ${userId} attempted action: ${event.type}. Ignoring.`);
                    continue;
                }


                const { data: globalSetting } = await supabase
                    .from("system_settings")
                    .select("value")
                    .eq("key", "ai_global_enabled")
                    .maybeSingle();


                isGlobalAiOn = globalSetting ? (globalSetting.value === true || globalSetting.value === "true") : true;
                isUserAiOn = userData ? (userData.ai_status !== false) : true;


                if (event.type === "message" && event.message.type === "text") {
                    const text = event.message.text.trim().toLowerCase();

                    if (text === "ai off") {
                        await supabase.from("user_profiles").update({ ai_status: false }).eq("userId", userId);
                        await replyMessage(event.replyToken, [{ type: "text", text: "🔕 ปิด AI สำหรับคุณเรียบร้อยแล้ว (แอดมินจะมาตอบเองครับ)" }]);
                        continue;
                    }

                    if (text === "ai on") {
                        await supabase.from("user_profiles").update({ ai_status: true }).eq("userId", userId);
                        await replyMessage(event.replyToken, [{ type: "text", text: "🔔 เปิด AI ผู้ช่วยตอบกลับอัตโนมัติเรียบร้อยแล้วครับ" }]);
                        continue;
                    }
                }




            } catch (err) {
                console.error("Error checking AI/Block status:", err);
            }
        }


        const replacePlaceholders = (str, profile) => {
            if (!str || typeof str !== 'string') return str;
            let result = str.replace(/{name}/g, profile.displayName || "คุณ");
            const defaultPicture = "https://via.placeholder.com/200x200?text=No+Image";
            const userPicture = profile.pictureUrl || defaultPicture;
            result = result.replace(/{picture}/g, userPicture);
            return result;
        };


        const parseThaiDateTime = (dateTimeString) => {
            if (!dateTimeString) return null;
            try {
                const [datePart, timePart] = dateTimeString.split(' ');
                if (!datePart || !timePart) return null;
                const [day, month, year] = datePart.split('/').map(Number);
                return new Date(`${year}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}T${timePart}:00+07:00`);
            } catch (e) {
                console.error("Date parse error:", e);
                return null;
            }
        };

        switch (event.type) {
            case "join": {
                if (event.source.type === "group") {
                    const groupId = event.source.groupId;
                    await supabase.from("line_groups").upsert({
                        group_id: groupId,
                        joined_at: new Date().toISOString()
                    });

                    try {
                        const res = await fetch(`${LINE_API}/group/${groupId}/summary`, {
                            headers: { "Authorization": `Bearer ${CHANNEL_ACCESS_TOKEN}` }
                        });
                        const summary = await res.json();
                        const text = `🔔 <b>บอทถูกเชิญเข้ากลุ่มใหม่</b>\n<b>ชื่อกลุ่ม:</b> ${summary.groupName || 'ไม่ทราบชื่อ'}\n<b>GroupId:</b> ${groupId}`;
                        await notifyAdminByTelegram(text);
                    } catch (e) { }
                    let replies: any[] = [{ type: "text", text: "สวัสดีครับ ขอบคุณที่เชิญบอทเข้ากลุ่ม 🤖" }];
                    try {
                        const { data: settingData } = await supabase.from('system_settings').select('value').eq('key', 'bot_join_message').maybeSingle();
                        if (settingData && settingData.value) {
                            const val = settingData.value;
                            if (typeof val === 'object' && val.type && val.content) {
                                if (val.type === 'text') {
                                    replies = [{ type: "text", text: val.content }];
                                } else if (val.type === 'image') {
                                    replies = [{ type: "image", originalContentUrl: val.content, previewImageUrl: val.content }];
                                } else if (val.type === 'flex') {
                                    replies = [{ type: "flex", altText: "flex message", contents: JSON.parse(val.content) }];
                                } else if (val.type === 'template') {
                                    replies = [JSON.parse(val.content)];
                                } else if (val.type === 'textV2') {
                                    replies = [JSON.parse(val.content)];
                                }
                            } else if (typeof val === 'string') {
                                replies = [{ type: "text", text: val }];
                            }
                        }
                    } catch (e) {
                        console.error('Error parsing join message setting:', e);
                    }

                    await replyMessage(event.replyToken, replies);
                }
                break;
            }
            case "leave": {
                if (event.source.type === "group") {
                    const groupId = event.source.groupId;
                    await supabase.from("line_groups").delete().eq("group_id", groupId);
                }
                break;
            }
            case "memberJoined": {
                if (event.source.type === "group" && event.joined && event.joined.members) {
                    const groupId = event.source.groupId;
                    let firstMemberProfile: any = null;

                    for (const member of event.joined.members) {
                        try {
                            const pRes = await fetch(`${LINE_API}/group/${groupId}/member/${member.userId}`, {
                                headers: { "Authorization": `Bearer ${CHANNEL_ACCESS_TOKEN}` }
                            });
                            if (pRes.ok) {
                                const profile = await pRes.json();
                                if (!firstMemberProfile) firstMemberProfile = profile;

                                await supabase.from("user_profiles").upsert({
                                    userId: member.userId,
                                    displayName: profile.displayName,
                                    pictureUrl: profile.pictureUrl,
                                    statusMessage: profile.statusMessage,
                                    updated_at: new Date().toISOString()
                                }, { onConflict: 'userId' });
                            }

                            await supabase.from("group_members").upsert({
                                group_id: groupId,
                                user_id: member.userId,
                                joined_at: new Date().toISOString()
                            }, { onConflict: 'group_id,user_id' });
                        } catch (e) {
                            console.error("Error processing memberJoined:", e);
                        }
                    }

                    const displayName = firstMemberProfile?.displayName || "สมาชิกใหม่";
                    const pictureUrl = firstMemberProfile?.pictureUrl || "https://cdn-icons-png.flaticon.com/512/847/847966.png";

                    let replies: any[] = [{ type: "text", text: `ยินดีต้อนรับคุณ ${displayName} เข้าสู่กลุ่มครับ 🎉` }];
                    try {
                        const { data: settingData } = await supabase.from('system_settings').select('value').eq('key', 'member_join_message').maybeSingle();
                        if (settingData && settingData.value) {
                            const val = settingData.value;
                            if (typeof val === 'object' && val.type && val.content) {
                                let contentStr = val.content;
                                const firstUserId = event.joined.members[0].userId;
                                contentStr = contentStr.replace(/{name}/g, displayName).replace(/{picture}/g, pictureUrl).replace(/{userId}/g, firstUserId);

                                if (val.type === 'text') {
                                    replies = [{ type: "text", text: contentStr }];
                                } else if (val.type === 'image') {
                                    replies = [{ type: "image", originalContentUrl: contentStr, previewImageUrl: contentStr }];
                                } else if (val.type === 'flex') {
                                    replies = [{ type: "flex", altText: "ยินดีต้อนรับสมาชิกใหม่", contents: JSON.parse(contentStr) }];
                                } else if (val.type === 'template') {
                                    replies = [JSON.parse(contentStr)];
                                } else if (val.type === 'textV2') {
                                    replies = [JSON.parse(contentStr)];
                                }
                            } else if (typeof val === 'string') {
                                const firstUserId = event.joined.members[0].userId;
                                replies = [{ type: "text", text: val.replace(/{name}/g, displayName).replace(/{picture}/g, pictureUrl).replace(/{userId}/g, firstUserId) }];
                            }
                        }
                    } catch (e) {
                        console.error('Error parsing member join message setting:', e);
                    }
                    await replyMessage(event.replyToken, replies);
                }
                break;
            }
            case "memberLeft": {
                if (event.source.type === "group" && event.left && event.left.members) {
                    const groupId = event.source.groupId;
                    for (const member of event.left.members) {
                        try {
                            await supabase.from("group_members").delete().match({ group_id: groupId, user_id: member.userId });
                        } catch (e) {
                            console.error("Error deleting memberLeft:", e);
                        }
                    }
                }
                break;
            }
            case "follow":
                {
                    const profileRes = await fetch(`${LINE_API}/profile/${event.source.userId}`, {
                        headers: {
                            "Authorization": `Bearer ${CHANNEL_ACCESS_TOKEN}`
                        }
                    });
                    const profile = await profileRes.json();

                    const { error } = await supabase.from("user_profiles").upsert({
                        userId: event.source.userId,
                        displayName: profile.displayName,
                        pictureUrl: profile.pictureUrl,
                        statusMessage: profile.statusMessage,
                        status: 'follow',
                        updated_at: new Date().toISOString()
                    }, {
                        onConflict: 'userId'
                    });

                    if (error) console.error("Upsert user_profiles error:", error);

                    const text = `
🔔 <b>มีเพื่อนใหม่แอด LINE OA</b>
<b>ชื่อ:</b> ${profile.displayName}
<b>UserId:</b> ${profile.userId}
              
<a href="${profile.pictureUrl}">ดูรูปภาพผู้มาใหม่</a>
              `;
                    await notifyAdminByTelegram(text);


                    const { data: welcomeConfigs } = await supabase
                        .from("keywords")
                        .select("*")
                        .eq("keyword", "welcome");

                    const messages = [];

                    if (welcomeConfigs && welcomeConfigs.length > 0) {


                        if (welcomeConfigs[0].reply_richmenu) {
                            await linkRichMenu(event.source.userId, welcomeConfigs[0].reply_richmenu);
                        }


                        for (const row of welcomeConfigs.slice(0, 5)) {
                            if (row.reply_flex) {
                                try {
                                    const flexContent = replacePlaceholders(row.reply_flex, profile);
                                    messages.push({
                                        type: "flex",
                                        altText: "ยินดีต้อนรับ",
                                        contents: JSON.parse(flexContent)
                                    });
                                } catch (e) {
                                    console.error("Error parsing welcome flex:", e);
                                }
                            } else if (row.reply_template) {
                                try {
                                    const templateContent = replacePlaceholders(row.reply_template, profile);
                                    messages.push(JSON.parse(templateContent));
                                } catch (e) {
                                    console.error(e);
                                }
                            } else if (row.reply_image) {
                                const imgUrl = replacePlaceholders(row.reply_image, profile);
                                messages.push({
                                    type: "image",
                                    originalContentUrl: imgUrl,
                                    previewImageUrl: imgUrl
                                });
                            } else if (row.reply_text) {
                                messages.push({
                                    type: "text",
                                    text: replacePlaceholders(row.reply_text, profile)
                                });
                            }
                        }
                    }


                    if (messages.length === 0) {
                        messages.push(createWelcomeFlex(profile.displayName));
                    }

                    await replyMessage(event.replyToken, messages);
                    break;
                }

            case "unfollow":
                {
                    console.log(`User ${event.source.userId} has unfollowed.`);
                    const { error } = await supabase.from("user_profiles").update({
                        status: 'unfollow',
                        updated_at: new Date().toISOString()
                    }).eq('userId', event.source.userId);
                    if (error) {
                        console.error("Update user_profiles error (unfollow):", error);
                    }
                    break;
                }
            case "postback":
                {
                    try {
                        const profileRes = await fetch(`${LINE_API}/profile/${userId}`, {
                            headers: { "Authorization": `Bearer ${CHANNEL_ACCESS_TOKEN}` }
                        });
                        const profile = await profileRes.json();

                        const postbackData = event.postback.data;
                        const replyToken = event.replyToken;

                        // --- [DYNAMIC FORM SYSTEM POSTBACK] ---
                        if (postbackData === "action=form_cancel") {
                            await startLoadingIndicator(userId, 5);
                            await supabase.from('form_submissions').delete().eq('user_id', userId).eq('status', 'pending');
                            await replyMessage(replyToken, [{ type: 'text', text: "❌ ยกเลิกการกรอกฟอร์มแล้วครับ คุณสามารถเริ่มใหม่ได้ทุกเมื่อ" }]);
                            break;
                        }

                        if (postbackData === "action=form_back") {
                            await startLoadingIndicator(userId, 5);
                            const { data: sub } = await supabase.from('form_submissions').select('*').eq('user_id', userId).eq('status', 'pending').maybeSingle();
                            if (sub && sub.current_field_index > 0) {
                                const prevIndex = sub.current_field_index - 1;
                                await supabase.from('form_submissions').update({ current_field_index: prevIndex }).eq('id', sub.id);
                                
                                const { data: fields } = await supabase.from('form_fields').select('*').eq('form_id', sub.form_id).order('order_index', { ascending: true });
                                const prevField = fields[prevIndex];
                                await replyMessage(replyToken, [createFormFieldFlex(prevField, prevIndex, fields.length)]);
                            } else {
                                await replyMessage(replyToken, [{ type: 'text', text: "ไม่สามารถย้อนกลับได้มากกว่านี้แล้วครับ" }]);
                            }
                            break;
                        }
                        // --- [END DYNAMIC FORM POSTBACK] ---
                        const { data: potentialData, error } = await supabase.from("keywords").select("*").ilike("reply_postback", `%${postbackData}%`);
                        if (error) throw error;

                        const data = potentialData ? potentialData.filter(kw => {
                            if (!kw.reply_postback) return false;
                            const tags = kw.reply_postback.split(',').map(s => s.trim());
                            return tags.includes(postbackData);
                        }) : [];

                        if (data && data.length > 0) {
                            const allowedKeywords = [];
                            const now = new Date();

                            for (const kw of data) {
                                let isConditionValid = true;
                                const startDateTime = parseThaiDateTime(kw.startdatetime);
                                const endDateTime = parseThaiDateTime(kw.enddatetime);

                                if (startDateTime && !isNaN(startDateTime.getTime()) && now < startDateTime) isConditionValid = false;
                                if (endDateTime && !isNaN(endDateTime.getTime()) && now > endDateTime) isConditionValid = false;

                                if (isConditionValid) {
                                    if (kw.require_vip) {
                                        const { data: permissionData } = await supabase
                                            .from("keyword_permissions")
                                            .select("vip")
                                            .eq("userId", userId)
                                            .ilike("keyword", kw.keyword || "")
                                            .maybeSingle();

                                        if (permissionData && permissionData.vip) {
                                            allowedKeywords.push(kw);
                                        }
                                    } else {
                                        allowedKeywords.push(kw);
                                    }
                                }
                            }

                            if (allowedKeywords.length > 0) {
                                const targetKw = allowedKeywords[0];
                                if (targetKw.reply_richmenu) {
                                    await linkRichMenu(userId, targetKw.reply_richmenu);
                                }

                                const replies = [];
                                for (const row of allowedKeywords.slice(0, 5)) {
                                    if (row.reply_flex) {
                                        try {
                                            const flexContent = replacePlaceholders(row.reply_flex, profile);
                                            replies.push({
                                                type: "flex",
                                                altText: "flex message",
                                                contents: JSON.parse(flexContent)
                                            });
                                        } catch (e) { console.error("Error parsing flex:", e); }
                                    } else if (row.reply_template) {
                                        try {
                                            const templateContent = replacePlaceholders(row.reply_template, profile);
                                            replies.push(JSON.parse(templateContent));
                                        } catch (e) { console.error("Error parsing template:", e); }
                                    } else if (row.reply_text) {
                                        replies.push({
                                            type: "text",
                                            text: replacePlaceholders(row.reply_text, profile)
                                        });
                                    } else if (row.reply_image) {
                                        const imgUrl = replacePlaceholders(row.reply_image, profile);
                                        replies.push({
                                            type: "image",
                                            originalContentUrl: imgUrl,
                                            previewImageUrl: imgUrl
                                        });
                                    }
                                }

                                if (targetKw.reply_prompt) {

                                    if (!isGlobalAiOn || !isUserAiOn) {
                                        console.log(`AI is OFF. Skipping reply_prompt for postback keyword.`);
                                        break;
                                    }
                                    await startLoadingIndicator(userId, 15);
                                    const aiResponse = await geminiApi(targetKw.reply_prompt);
                                    await replyMessage(event.replyToken, [{
                                        type: 'text',
                                        text: aiResponse
                                    }]);
                                } else if (replies.length > 0) {
                                    await startLoadingIndicator(userId, 5);
                                    await replyMessage(replyToken, replies);
                                }
                            } else {

                                const isTimeIssue = data.some(kw => {
                                    const s = parseThaiDateTime(kw.startdatetime);
                                    const e = parseThaiDateTime(kw.enddatetime);
                                    return (s && now < s) || (e && now > e);
                                });
                                let rejectMsg = `คุณไม่มีสิทธิ์ใช้งานเมนูนี้ครับ`;
                                if (isTimeIssue) {
                                    rejectMsg = `เมนูนี้ยังไม่เปิดใช้งาน หรือหมดอายุแล้วครับ`;
                                }
                                await replyMessage(replyToken, [{ type: 'text', text: rejectMsg }]);
                            }
                        }
                    } catch (error) {
                        console.error("Error processing postback event:", error);
                    }
                    break;
                }
            case "message":
                {
                    const msg = event.message;
                    const profileRes = await fetch(`${LINE_API}/profile/${userId}`, {
                        headers: {
                            "Authorization": `Bearer ${CHANNEL_ACCESS_TOKEN}`
                        }
                    });
                    const profile = await profileRes.json();


                    if (event.source.type === "group" && event.source.groupId) {
                        try {
                            await supabase.from("group_members").upsert({
                                group_id: event.source.groupId,
                                user_id: userId,
                                joined_at: new Date().toISOString()
                            }, { onConflict: 'group_id,user_id' });
                        } catch (e) {
                            console.error("Error saving group_members map:", e);
                        }
                    }
                    if (msg.type === "text") {

                        const { data: existingUser } = await supabase.from("user_profiles").select("userId").eq("userId", userId).maybeSingle();
                        if (!existingUser) {
                            await supabase.from("user_profiles").upsert({
                                userId,
                                displayName: profile.displayName,
                                pictureUrl: profile.pictureUrl,
                                statusMessage: profile.statusMessage,
                                status: 'follow',
                                updated_at: new Date().toISOString()
                            }, {
                                onConflict: 'userId'
                            });
                        }

                        const keywordText = msg.text.trim();
                        const lowerKeywordText = keywordText.toLowerCase();

                        // --- [DYNAMIC FORM SYSTEM] ---
                        // 1. ตรวจสอบว่า User กำลังกรอกฟอร์มค้างอยู่หรือไม่
                        const { data: ongoingSub } = await supabase
                            .from('form_submissions')
                            .select('*, forms(*)')
                            .eq('user_id', userId)
                            .eq('status', 'pending')
                            .maybeSingle();

                        if (ongoingSub) {
                            await startLoadingIndicator(userId, 15); // แสดงสถานะกำลังพิมพ์ทุกครั้งที่ตอบฟอร์ม
                            
                            const formId = ongoingSub.form_id;
                            const currentIndex = ongoingSub.current_field_index;

                            const { data: fields } = await supabase.from('form_fields').select('*').eq('form_id', formId).order('order_index', { ascending: true });
                            const currentField = fields?.[currentIndex];

                            if (currentField) {
                                // บันทึกคำตอบลง form_responses (ถ้ามีคำตอบเดิมสำหรับข้อนี้ให้ทับของเดิมทันที)
                                await supabase.from('form_responses').upsert({
                                    submission_id: ongoingSub.id,
                                    field_id: currentField.id,
                                    response_value: keywordText 
                                }, { onConflict: 'submission_id,field_id' });

                                // เลื่อนไปข้อถัดไป
                                const nextIndex = currentIndex + 1;

                                if (nextIndex >= (fields?.length || 0)) {
                                    // จบฟอร์มแล้ว!
                                    await supabase.from('form_submissions').update({
                                        status: 'completed',
                                        completed_at: new Date().toISOString(),
                                        current_field_index: nextIndex
                                    }).eq('id', ongoingSub.id);

                                    // ดึงคำตอบทั้งหมดเพื่อส่งสรุป
                                    const { data: allResponses } = await supabase
                                        .from('form_responses')
                                        .select('*, form_fields(label)')
                                        .eq('submission_id', ongoingSub.id)
                                        .order('field_id', { ascending: true });

                                    // ดึงโปรไฟล์ล่าสุด
                                    const { data: profile } = await supabase.from('user_profiles').select('*').eq('userId', userId).single();

                                    // --- [TELEGRAM NOTIFICATION] ---
                                    let tgText = `🔔 <b>มีผู้กรอกฟอร์มใหม่เข้ามา!</b>\n`;
                                    tgText += `📋 <b>ฟอร์ม:</b> ${ongoingSub.forms.title}\n`;
                                    tgText += `👤 <b>ผู้ส่ง:</b> ${profile?.displayName || 'Unknown'} (<code>${userId}</code>)\n\n`;
                                    tgText += `📝 <b>รายการคำตอบ:</b>\n`;
                                    
                                    (allResponses || []).forEach((r, i) => {
                                        tgText += `${i + 1}. <b>${r.form_fields?.label}:</b> ${r.response_value}\n`;
                                    });

                                    await notifyAdminByTelegram(tgText);
                                    // --- [END TELEGRAM] ---

                                    await replyMessage(event.replyToken, [{
                                        type: "flex",
                                        altText: `สรุป: ${ongoingSub.forms.title}`,
                                        contents: createFormSummaryFlex(profile, allResponses, ongoingSub.forms.success_message, ongoingSub.forms.title)
                                    }]);
                                } else {
                                    // ส่งคำถามข้อต่อไป
                                    await supabase.from('form_submissions').update({
                                        current_field_index: nextIndex
                                    }).eq('id', ongoingSub.id);

                                    const nextField = fields[nextIndex];
                                    const fieldMessage = createFormFieldFlex(nextField, nextIndex, fields.length);
                                    await replyMessage(event.replyToken, [fieldMessage]);
                                }
                                break; 
                            }
                        }

                        // 2. ตรวจสอบ Keyword เพื่อเริ่มฟอร์มใหม่
                        const { data: formToStart } = await supabase
                            .from('forms')
                            .select('*')
                            .eq('keyword', keywordText)
                            .eq('is_active', true)
                            .maybeSingle();

                        if (formToStart) {
                            await startLoadingIndicator(userId, 15);
                            // สร้าง Submission ใหม่
                            const { data: newSub } = await supabase.from('form_submissions').insert({
                                form_id: formToStart.id,
                                user_id: userId,
                                status: 'pending'
                            }).select().single();

                            // ดึงคำถามข้อแรก
                            const { data: firstFields } = await supabase.from('form_fields').select('*').eq('form_id', formToStart.id).order('order_index', { ascending: true });
                            
                            if (firstFields && firstFields.length > 0) {
                                const fieldMessage = createFormFieldFlex(firstFields[0], 0, firstFields.length);
                                await replyMessage(event.replyToken, [fieldMessage]);
                            }
                            break;
                        }
                        // --- [END DYNAMIC FORM SYSTEM] ---

                        if (lowerKeywordText.startsWith('hello')) {
                            try {
                                await startLoadingIndicator(userId, 5);
                                await replyMessage(event.replyToken, [{
                                    type: 'text',
                                    text: `ไงครับ`
                                }]);
                            } catch (error) {
                                console.error("Error replying hello:", error);
                                await replyMessage(event.replyToken, [{
                                    type: 'text',
                                    text: `เกิดข้อผิดพลาด`
                                }]);
                            }
                        } else {

                            const { data: potentialKeywords, error } = await supabase
                                .from("keywords")
                                .select("*")
                                .ilike("keyword", `%${keywordText}%`);

                            if (error) {
                                console.error("Error fetching keywords:", error);
                                throw error;
                            }

                            const allMatchingKeywords = potentialKeywords.filter(kw => {
                                if (!kw.keyword) return false;
                                const tags = kw.keyword.split(',').map(s => s.trim().toLowerCase());
                                return tags.includes(lowerKeywordText);
                            });

                            if (!allMatchingKeywords || allMatchingKeywords.length === 0) {


                                try {

                                    if (!isGlobalAiOn || !isUserAiOn) {
                                        console.log(`AI is OFF for user ${userId} (Global: ${isGlobalAiOn}, User: ${isUserAiOn}). Skipping AI logic.`);
                                        break;
                                    }



                                    const { error: userHistError } = await supabase
                                        .from('chat_history')
                                        .insert({
                                            user_id: userId,
                                            role: 'user',
                                            message: keywordText
                                        });

                                    if (userHistError) {
                                        console.error("Error saving user history:", userHistError);
                                    }


                                    supabase.from('system_settings').upsert({ key: `chat_meta_${userId}`, value: { unread: true, timestamp: Date.now() } }).then();


                                    const KNOWLEDGE_URL = "xxxxxxxxxxx";
                                    let docContext = "";
                                    let pdfBase64 = null;

                                    if (KNOWLEDGE_URL && !KNOWLEDGE_URL.includes("xxxxx")) {
                                        // Use Cache if URL is same
                                        if (KNOWLEDGE_URL === cachedKnowledgeUrl && (cachedPdfBase64 || cachedDocContext)) {
                                            pdfBase64 = cachedPdfBase64;
                                            docContext = cachedDocContext;
                                        } else {
                                            try {
                                                let finalUrl = KNOWLEDGE_URL;

                                                // Handle Google Drive
                                                if (KNOWLEDGE_URL.includes("drive.google.com")) {
                                                    const fileId = KNOWLEDGE_URL.match(/\/d\/([^\/]+)/)?.[1];
                                                    if (fileId) finalUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
                                                }

                                                const res = await fetch(finalUrl);
                                                const contentType = res.headers.get("content-type") || "";
                                                const isPdf = contentType.includes("pdf") || finalUrl.toLowerCase().split('?')[0].endsWith(".pdf") || KNOWLEDGE_URL.includes("drive.google.com");

                                                if (res.ok) {
                                                    if (isPdf) {
                                                        const arrayBuffer = await res.arrayBuffer();
                                                        const uint8 = new Uint8Array(arrayBuffer);

                                                        // Safer Base64 conversion for large files
                                                        let binary = "";
                                                        const len = uint8.byteLength;
                                                        const chunkSize = 10000;
                                                        for (let i = 0; i < len; i += chunkSize) {
                                                            const chunk = uint8.subarray(i, i + chunkSize);
                                                            binary += String.fromCharCode.apply(null, chunk as any);
                                                        }
                                                        pdfBase64 = btoa(binary);

                                                        // Update Cache
                                                        cachedKnowledgeUrl = KNOWLEDGE_URL;
                                                        cachedPdfBase64 = pdfBase64;
                                                        cachedDocContext = "";
                                                    } else {
                                                        const rawText = await res.text();
                                                        try {
                                                            const jsonData = JSON.parse(rawText);
                                                            docContext = JSON.stringify(jsonData, null, 2).slice(0, 10000);
                                                        } catch (jsonErr) {
                                                            docContext = rawText.slice(0, 10000);
                                                        }
                                                        // Update Cache
                                                        cachedKnowledgeUrl = KNOWLEDGE_URL;
                                                        cachedPdfBase64 = null;
                                                        cachedDocContext = docContext;
                                                    }
                                                } else {
                                                    const errText = await res.text();
                                                    await notifyAdminByTelegram(`⚠️ <b>DocAI Fetch Failed:</b> ${res.status}\nURL: ${finalUrl}\nError: ${errText.slice(0, 200)}`);
                                                }
                                            } catch (fetchErr: any) {
                                                console.error("DocAI Error:", fetchErr);
                                                await notifyAdminByTelegram(`❌ <b>DocAI Error:</b> ${fetchErr.message}`);
                                            }
                                        }
                                    }


                                    const { data: historyData, error: historyError } = await supabase
                                        .from('chat_history')
                                        .select('role, message')
                                        .eq('user_id', userId)
                                        .order('created_at', { ascending: false })
                                        .limit(5);

                                    if (historyError) {
                                        console.error("Error loading chat history:", historyError);
                                    }

                                    const currentMessage = `user: ${keywordText}`;

                                    const historyContext = historyData && historyData.length > 0
                                        ? [...historyData.reverse().map(h => `${h.role}: ${h.message}`), currentMessage].join("\n")
                                        : currentMessage;


                                    const systemPrompt = `
บทบาท: คุณคือ AI Assistant ที่เชี่ยวชาญในการตอบคำถามโดยอ้างอิงจากข้อมูลที่ได้รับ (Knowledge Base) เท่านั้น

กฎเหล็กที่ต้องทำตามอย่างเคร่งครัด:
1. ตอบคำถามโดยใช้ข้อมูลจาก Knowledge Base ที่แนบมาให้เท่านั้น (อาจเป็นไฟล์ PDF หรือข้อความ JSON)
2. หากในข้อมูลที่ให้มา "ไม่มีคำตอบ" หรือ "ไม่เกี่ยวข้อง" กับคำถาม ให้ตอบเพียงคำเดียวว่า "SILENT" เท่านั้น ห้ามตอบอย่างอื่นเด็ดขาด
3. ห้ามใช้ความรู้รอบตัวหรือเดาคำตอบเองเด็ดขาด ถ้าไม่มีในไฟล์ให้ตอบ "SILENT"
4. ห้ามทักทายหรือพูดนอกเรื่อง ถ้าถามสิ่งที่ไม่มีในข้อมูล ให้ตอบ "SILENT" ทันที

Chat History:
${historyContext}

User Question:
${keywordText}

Answer:
`;

                                    let aiPayload: any = [{ text: systemPrompt }];
                                    if (pdfBase64) {
                                        aiPayload = [
                                            { text: systemPrompt + (docContext ? `\nJSON Context: ${docContext}` : "") },
                                            { inline_data: { mime_type: "application/pdf", data: pdfBase64 } }
                                        ];
                                    } else if (docContext) {
                                        aiPayload = systemPrompt + `\nKnowledge Base:\n${docContext}`;
                                    }


                                    const aiResponse = await geminiApi(aiPayload);
                                    const cleanResponse = aiResponse ? aiResponse.trim() : "SILENT";

                                    const isSilent = cleanResponse.toUpperCase().includes("SILENT") || 
                                                     cleanResponse.includes("ไม่พบข้อมูล") || 
                                                     cleanResponse.includes("ขออภัย") || 
                                                     cleanResponse.includes("ไม่มีข้อมูล") ||
                                                     cleanResponse.toUpperCase().includes("I DON'T KNOW") ||
                                                     cleanResponse.toUpperCase().includes("SORRY");

                                    if (!isSilent && cleanResponse.length > 0) {

                                        await startLoadingIndicator(userId, 15);
                                        await replyMessage(event.replyToken, [{
                                            type: 'text',
                                            text: cleanResponse,
                                            quoteToken: msg.quoteToken
                                        }]);
                                    }

                                } catch (err) {
                                    console.error("Gemini/DocAI Logic Error:", err);
                                }

                                break;
                            }


                            const allowedKeywords = [];
                            const now = new Date();

                            for (const kw of allMatchingKeywords) {
                                let isConditionValid = true;

                                const startDateTime = parseThaiDateTime(kw.startdatetime);
                                const endDateTime = parseThaiDateTime(kw.enddatetime);

                                if (startDateTime && !isNaN(startDateTime.getTime()) && now < startDateTime) {
                                    isConditionValid = false;
                                    console.log(`Keyword "${kw.keyword}" ยังไม่เริ่ม (Start: ${kw.startdatetime})`);
                                }

                                if (endDateTime && !isNaN(endDateTime.getTime()) && now > endDateTime) {
                                    isConditionValid = false;
                                    console.log(`Keyword "${kw.keyword}" หมดอายุ (End: ${kw.enddatetime})`);
                                }

                                if (isConditionValid) {
                                    if (kw.require_vip) {
                                        const { data: permissionData } = await supabase
                                            .from("keyword_permissions")
                                            .select("vip")
                                            .eq("userId", userId)
                                            .ilike("keyword", kw.keyword)
                                            .maybeSingle();

                                        if (permissionData && permissionData.vip) {
                                            allowedKeywords.push(kw);
                                        }
                                    } else {
                                        allowedKeywords.push(kw);
                                    }
                                }
                            }


                            if (allowedKeywords.length > 0) {

                                const targetKw = allowedKeywords[0];


                                if (targetKw.reply_richmenu) {
                                    await linkRichMenu(userId, targetKw.reply_richmenu);
                                }

                                const replies = [];

                                for (const row of allowedKeywords.slice(0, 5)) {
                                    if (row.reply_flex) {
                                        try {
                                            const flexContent = replacePlaceholders(row.reply_flex, profile);
                                            replies.push({
                                                type: "flex",
                                                altText: "flex message",
                                                contents: JSON.parse(flexContent)
                                            });
                                        } catch (e) { console.error("Error parsing flex:", e); }
                                    } else if (row.reply_template) {
                                        try {
                                            const templateContent = replacePlaceholders(row.reply_template, profile);
                                            replies.push(JSON.parse(templateContent));
                                        } catch (e) { console.error("Error parsing template:", e); }
                                    } else if (row.reply_text) {
                                        replies.push({
                                            type: "text",
                                            text: replacePlaceholders(row.reply_text, profile),
                                            quoteToken: msg.quoteToken
                                        });
                                    } else if (row.reply_image) {
                                        const imgUrl = replacePlaceholders(row.reply_image, profile);
                                        replies.push({
                                            type: "image",
                                            originalContentUrl: imgUrl,
                                            previewImageUrl: imgUrl
                                        });
                                    }
                                }


                                if (targetKw.reply_prompt) {

                                    if (!isGlobalAiOn || !isUserAiOn) {
                                        console.log(`AI is OFF. Skipping reply_prompt for keyword.`);
                                        break;
                                    }
                                    await startLoadingIndicator(userId, 15);
                                    const aiResponse = await geminiApi(targetKw.reply_prompt);

                                    await replyMessage(event.replyToken, [{
                                        type: 'text',
                                        text: aiResponse,
                                        quoteToken: msg.quoteToken
                                    }]);
                                }

                                else if (replies.length > 0) {
                                    await startLoadingIndicator(userId, 5);
                                    await replyMessage(event.replyToken, replies);
                                }

                            } else {

                                const isTimeIssue = allMatchingKeywords.some(kw => {
                                    const s = parseThaiDateTime(kw.startdatetime);
                                    const e = parseThaiDateTime(kw.enddatetime);
                                    return (s && now < s) || (e && now > e);
                                });

                                let rejectMsg = `คุณไม่มีสิทธิ์ในคีย์เวิร์ดนี้`;
                                if (isTimeIssue) {
                                    rejectMsg = `คีย์เวิร์ดนี้ยังไม่เปิดใช้งาน หรือหมดอายุแล้วครับ`;
                                }

                                await replyMessage(event.replyToken, [{
                                    type: 'text',
                                    text: rejectMsg,
                                    quoteToken: msg.quoteToken
                                }]);
                            }
                        }


                    } else if (msg.type === "image") {
                        const contentUrl = `https://api-data.line.me/v2/bot/message/${msg.id}/content`;
                        const imgRes = await fetch(contentUrl, {
                            headers: { "Authorization": `Bearer ${CHANNEL_ACCESS_TOKEN}` }
                        });
                        if (!imgRes.ok) {
                            await replyMessage(event.replyToken, [{ type: "text", text: "ไม่สามารถดึงภาพจาก LINE ได้" }]);
                            break;
                        }
                        const buffer = new Uint8Array(await imgRes.arrayBuffer());
                        const contentType = imgRes.headers.get("content-type") || "image/jpeg";
                        const ext = contentType.split("/")[1];
                        const filename = `${userId}/${Date.now()}.${ext}`;
                        const { error } = await supabase.storage.from("user-images").upload(filename, buffer, {
                            contentType,
                            upsert: true
                        });
                        if (error) {
                            console.error("Upload error:", error);
                            await replyMessage(event.replyToken, [{ type: "text", text: "อัปโหลดภาพล้มเหลว" }]);
                        } else {
                            const publicUrl = `${Deno.env.get("SUPABASE_URL")}/storage/v1/object/public/user-images/${filename}`;

                            await supabase.from('chat_history').insert({ user_id: userId, role: 'user', message: `[IMAGE] ${publicUrl}` });
                            supabase.from('system_settings').upsert({ key: `chat_meta_${userId}`, value: { unread: true, timestamp: Date.now() } }).then();

                            const text = `
🔔 <b>ผู้ใช้ส่งรูปเข้ามาใน LINE</b>
<b>ชื่อ: </b> ${profile.displayName}
<b>UserId: </b> ${profile.userId}
              
<a href="${publicUrl}">ดูรูปภาพที่ส่งเข้ามา</a>
              `;
                            await notifyAdminByTelegram(text);
                            await replyMessage(event.replyToken, [{ type: "text", text: "ได้รับรูปภาพแล้ว แอดมินจะรีบตรวจสอบให้นะครับ" }]);
                        }
                    } else if (msg.type === "sticker") {
                        const stickerUrl = `https://stickershop.line-scdn.net/stickershop/v1/sticker/${msg.stickerId}/iPhone/sticker@2x.png`;

                        await supabase.from('chat_history').insert({
                            user_id: userId,
                            role: 'user',
                            message: `[STICKER] ${stickerUrl}`
                        });
                        supabase.from('system_settings').upsert({ key: `chat_meta_${userId}`, value: { unread: true, timestamp: Date.now() } }).then();

                        const text = `
🔔 <b>ผู้ใช้ส่งสติกเกอร์ใน LINE</b>
<b>ชื่อ: </b> ${profile.displayName}
<b>UserId: </b> ${profile.userId}
              
<a href="${stickerUrl}">ดูสติกเกอร์ที่ส่งมา</a>
              `;
                        await notifyAdminByTelegram(text);
                    }
                    break;
                }
            default:
                {
                    console.log(`Unknown event type received: ${event.type}`);
                    break;
                }
        }
    }
}
async function notifyAdminByTelegram(text) {
    const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN");
    const TELEGRAM_CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID");
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const payload = {
        chat_id: TELEGRAM_CHAT_ID,
        text: text,
        parse_mode: "HTML"
    };
    try {
        const res = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!data.ok) {
            console.error("Telegram API error:", data);
        }
    } catch (err) {
        console.error("Telegram notify error:", err);
    }
}
async function linkRichMenu(userId, richMenuId) {
    const res = await fetch(`https://api.line.me/v2/bot/user/${userId}/richmenu/${richMenuId}`, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${CHANNEL_ACCESS_TOKEN}`
        }
    });
    if (!res.ok) {
        console.error("Link Rich Menu failed", res.status, await res.text());
    } else {
        console.log(`Rich Menu ${richMenuId} linked to ${userId}`);
    }
}
async function geminiApi(input: string | any[]) {
    const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
    if (!GEMINI_API_KEY) {
        throw new Error("GEMINI_API_KEY is not set ");
    }

    // Support both string prompt and parts array
    const parts = typeof input === 'string' ? [{ text: input }] : input;

    const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite-preview:generateContent?key=${GEMINI_API_KEY}`;
    const payload = {
        contents: [{ parts }]
    };

    const response = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        if (response.status === 429) {
            throw new Error("ขออภัยครับ ตอนนี้ AI กำลังประมวลผลหนักมาก ลองใหม่อีกครั้งในวันพรุ่งนี้ครับ 🤖");
        }
        const errorBody = await response.json();
        console.error("Gemini API Error:", errorBody);
        throw new Error(`Gemini API request failed with status ${response.status}`);
    }

    const result = await response.json();
    const generatedText = result.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!generatedText) {
        console.error("Invalid response structure from Gemini API:", result);
        throw new Error("Could not extract text from Gemini response.");
    }
    return generatedText.trim();
}
