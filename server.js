
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static("public"));

const rooms = new Map();
const COLORS = ["red", "yellow", "green", "blue"];
const TYPES = ["tuong", "si", "tuong_xe", "tuong_pha", "tuong_ma", "phao", "tot"];

function makeDeck() {
  const deck = [];
  // Bộ 112 lá: 16 loại, mỗi loại 4 lá.
  // Phiên bản web này dùng bộ 28 loại biểu tượng (mỗi loại 4).
  const pieces = [
    ["tuong","Tướng"], ["si","Sĩ"], ["tuong_xe","Xe"],
    ["tuong_pha","Pháo"], ["tuong_ma","Mã"], ["phao","Pháo"],
    ["tot","Tốt"]
  ];
  const colors = [
    ["red","Đỏ"], ["yellow","Vàng"], ["green","Xanh"], ["blue","Trắng"]
  ];
  // 7 loại x 4 màu x 4 lá = 112
  for (const [type, label] of pieces) {
    for (const [color, colorLabel] of colors) {
      for (let i=0;i<4;i++) {
        deck.push({
          id: crypto.randomUUID(),
          type, label, color, colorLabel,
          text: `${label} ${colorLabel}`
        });
      }
    }
  }
  return shuffle(deck);
}

function shuffle(a) {
  for (let i=a.length-1;i>0;i--) {
    const j=Math.floor(Math.random()*(i+1));
    [a[i],a[j]]=[a[j],a[i]];
  }
  return a;
}

function roomState(room) {
  return {
    code: room.code,
    players: room.players.map(p => ({
      id:p.id, name:p.name, ready:p.ready,
      cardCount:p.hand.length,
      score:p.score
    })),
    started: room.started,
    turn: room.turn,
    discardTop: room.discard.length ? room.discard[room.discard.length-1] : null,
    winner: room.winner,
    message: room.message
  };
}

function privateState(room, socketId) {
  const p = room.players.find(x=>x.id===socketId);
  return p ? { hand:p.hand, state:roomState(room) } : null;
}

function broadcastRoom(room) {
  for (const p of room.players) {
    io.to(p.id).emit("state", privateState(room,p.id));
  }
}

function nextTurn(room) {
  if (!room.players.length) return;
  let idx = room.players.findIndex(p=>p.id===room.turn);
  idx = (idx + 1) % room.players.length;
  room.turn = room.players[idx].id;
}

function canStart(room) {
  return room.players.length >= 2 && room.players.every(p=>p.ready);
}

function deal(room) {
  room.deck = makeDeck();
  room.discard = [];
  room.winner = null;
  room.message = "Ván mới bắt đầu.";
  room.started = true;
  room.players.forEach(p => {
    p.hand = [];
    p.ready = false;
    p.score = p.score || 0;
  });
  // Mỗi người 20 lá, người đi đầu 21 lá.
  for (let n=0;n<20;n++) {
    for (const p of room.players) p.hand.push(room.deck.pop());
  }
  room.players[0].hand.push(room.deck.pop());
  room.turn = room.players[0].id;
}

function removeCard(hand, id) {
  const i=hand.findIndex(c=>c.id===id);
  if(i<0) return null;
  return hand.splice(i,1)[0];
}

function sameGroup(a,b) {
  return a && b && a.type===b.type && a.color===b.color;
}

function hasWin(hand) {
  // Điều kiện thắng cơ bản cho bản demo:
  // 28 cặp = bộ bài hợp lệ (tổng số lá có thể khác tùy luật ăn/ghép).
  // Ở bản này cho phép thắng khi còn <= 4 lá và toàn bộ là cùng màu/nhóm.
  if (hand.length > 4) return false;
  if (!hand.length) return true;
  return hand.every(c=>c.color===hand[0].color);
}

io.on("connection", socket => {
  socket.on("createRoom", ({name}) => {
    const code = Math.random().toString(36).slice(2,7).toUpperCase();
    const room = {code, players:[], deck:[], discard:[], started:false, turn:null, winner:null, message:"Chờ người chơi...", maxPlayers:4};
    rooms.set(code,room);
    join(room,name || "Người chơi");
    socket.emit("roomCreated", code);
  });

  socket.on("joinRoom", ({code,name}) => {
    const room=rooms.get(String(code||"").toUpperCase());
    if(!room) return socket.emit("errorMsg","Không tìm thấy phòng.");
    if(room.started) return socket.emit("errorMsg","Ván đang diễn ra.");
    if(room.players.length>=room.maxPlayers) return socket.emit("errorMsg","Phòng đã đủ 4 người.");
    join(room,name || "Người chơi");
  });

  function join(room,name) {
    socket.join(room.code);
    room.players.push({id:socket.id,name:String(name).slice(0,16),hand:[],ready:false,score:0});
    socket.data.room=room.code;
    room.message=`${name} đã vào phòng.`;
    broadcastRoom(room);
  }

  socket.on("ready",()=>{
    const room=rooms.get(socket.data.room);
    if(!room || room.started) return;
    const p=room.players.find(x=>x.id===socket.id);
    if(!p) return;
    p.ready=!p.ready;
    room.message=p.ready ? `${p.name} đã sẵn sàng.` : `${p.name} chưa sẵn sàng.`;
    broadcastRoom(room);
    if(canStart(room)) {
      deal(room);
      broadcastRoom(room);
    }
  });

  socket.on("draw",()=>{
    const room=rooms.get(socket.data.room);
    if(!room || !room.started || room.winner) return;
    if(room.turn!==socket.id) return socket.emit("errorMsg","Chưa tới lượt bạn.");
    if(!room.deck.length) {
      room.message="Hết bài. Ván hòa.";
      room.winner="draw";
      broadcastRoom(room); return;
    }
    const p=room.players.find(x=>x.id===socket.id);
    p.hand.push(room.deck.pop());
    room.message=`${p.name} đã bốc bài. Hãy đánh 1 lá.`;
    broadcastRoom(room);
  });

  socket.on("discard",({cardId})=>{
    const room=rooms.get(socket.data.room);
    if(!room || !room.started || room.winner) return;
    if(room.turn!==socket.id) return socket.emit("errorMsg","Chưa tới lượt bạn.");
    const p=room.players.find(x=>x.id===socket.id);
    const card=removeCard(p.hand,cardId);
    if(!card) return socket.emit("errorMsg","Không tìm thấy lá bài.");
    room.discard.push(card);
    if(hasWin(p.hand)) {
      room.winner=p.id;
      p.score += 1;
      room.message=`${p.name} đã thắng!`;
    } else {
      nextTurn(room);
      const next=room.players.find(x=>x.id===room.turn);
      room.message=`Đến lượt ${next.name}.`;
    }
    broadcastRoom(room);
  });

  socket.on("newRound",()=>{
    const room=rooms.get(socket.data.room);
    if(!room) return;
    if(room.players.length<2) return socket.emit("errorMsg","Cần ít nhất 2 người.");
    deal(room);
    broadcastRoom(room);
  });

  socket.on("leave",()=>{
    leaveRoom(socket);
  });

  socket.on("disconnect",()=>{
    leaveRoom(socket);
  });

  function leaveRoom(s=socket) {
    const code=s.data.room;
    if(!code) return;
    const room=rooms.get(code);
    if(!room) return;
    room.players=room.players.filter(p=>p.id!==s.id);
    s.leave(code);
    delete s.data.room;
    if(room.players.length===0) rooms.delete(code);
    else {
      if(room.started && room.turn===s.id) room.turn=room.players[0].id;
      room.message="Một người chơi đã rời phòng.";
      broadcastRoom(room);
    }
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT,()=>console.log(`Tu Sac Online running on port ${PORT}`));
