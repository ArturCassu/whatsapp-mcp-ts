import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync("C:/Users/artur/Code/whatsapp-mcp-ts/data/whatsapp.db");
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log("tables", tables);
try {
  console.log("chats", db.prepare("SELECT COUNT(*) as c FROM chats").get());
  console.log("messages", db.prepare("SELECT COUNT(*) as c FROM messages").get());
  console.log(
    "sample",
    db.prepare("SELECT jid, name, last_message_time FROM chats ORDER BY last_message_time DESC LIMIT 5").all()
  );
} catch (e) {
  console.log("query_err", e.message);
}
