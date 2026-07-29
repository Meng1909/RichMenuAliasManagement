export function createWelcomeFlex(displayName) {
  const flexObject = {
    "type": "flex",
    "altText": "ข้อความต้อนรับ",
    "contents": {
      "type": "bubble",
      "header": {
        "type": "box",
        "layout": "vertical",
        "contents": [
          {
            "type": "text",
            "text": "WELCOME",
            "color": "#ffffff",
            "weight": "bold",
            "size": "xl"
          }
        ],
        "backgroundColor": "#007bff"
      },
      "body": {
        "type": "box",
        "layout": "vertical",
        "contents": [
          {
            "type": "text",
            "text": `สวัสดีคุณ ${displayName}!`,
            "weight": "bold",
            "size": "lg",
            "wrap": true
          },
          {
            "type": "text",
            "text": "ขอบคุณที่เพิ่มเราเป็นเพื่อน ยินดีให้บริการครับ",
            "wrap": true,
            "margin": "md"
          }
        ]
      },
      "footer": {
        "type": "box",
        "layout": "vertical",
        "contents": [
          {
            "type": "button",
            "action": {
              "type": "uri",
              "label": "เยี่ยมชมเว็บไซต์",
              "uri": "https://google.com"
            },
            "style": "primary",
            "color": "#007bff"
          }
        ]
      }
    }
  };
  return flexObject;
}