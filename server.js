const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const rooms = {};

app.use(express.static(__dirname));

io.on('connection', (socket) => {
    console.log('ユーザーが接続しました:', socket.id);

    // 1. ルーム作成・参加
    socket.on('join-room', ({ roomID, name }) => {
        socket.join(roomID);

        if (!rooms[roomID]) {
            rooms[roomID] = {
                roomID: roomID,
                status: 'waiting',
                users: [],
                history: []
            };
        }

        if (rooms[roomID].status !== 'waiting') {
            socket.emit('error-msg', 'この部屋のゲームはすでに開始されています。');
            return;
        }

        rooms[roomID].users.push({
            socketId: socket.id,
            name: name,
            inputWord: '',
            targetWord: '',
            giverName: '', // 【新規】このワードの考案者（提供者）の名前を固定で持つ
            outCount: 0,
            lastOutTime: 0
        });

        io.to(roomID).emit('room-data', rooms[roomID]);
    });

    // 2. NGワードの提出
    socket.on('submit-word', ({ roomID, word }) => {
        const room = rooms[roomID];
        if (!room) return;

        const user = room.users.find(u => u.socketId === socket.id);
        if (user) {
            user.inputWord = word;
        }

        io.to(roomID).emit('room-data', room);
    });

    // 3. ゲーム開始（シャッフル）
    socket.on('start-game', ({ roomID }) => {
        const room = rooms[roomID];
        if (!room || room.users.length < 2) return;
        if (room.users[0].socketId !== socket.id) return; // ホスト制限

        room.status = 'playing';
        room.history = [];

        const len = room.users.length;
        for (let i = 0; i < len; i++) {
            const nextIndex = (i + 1) % len;
            // 席替え方式で次の人のワードをもらう
            room.users[i].targetWord = room.users[nextIndex].inputWord;
            // 【修正】ワードをもらった相手の名前を「giverName」として確実に記憶（重複ワード対策）
            room.users[i].giverName = room.users[nextIndex].name;
            
            room.users[i].outCount = 0;
            room.users[i].lastOutTime = 0;
        }

        io.to(roomID).emit('game-started', room);
    });

    // 4. 「言っちゃった」ボタン（1分間重複防止）
    socket.on('say-ng-word', ({ roomID, targetSocketId, actorName }) => {
        const room = rooms[roomID];
        if (!room || room.status !== 'playing') return;

        const targetUser = room.users.find(u => u.socketId === targetSocketId);
        if (targetUser) {
            const currentTime = Date.now();
            const cooldown = 60 * 1000;

            if (currentTime - targetUser.lastOutTime < cooldown) {
                return;
            }

            targetUser.outCount += 1;
            targetUser.lastOutTime = currentTime;

            const logMessage = `${targetUser.name}さんがNGワード「${targetUser.targetWord}」を言っちゃいました！（指摘: ${actorName}）※次の1分間はカウントされません`;
            room.history.push(logMessage);

            io.to(roomID).emit('game-updated', room);
        }
    });

    // 5. ゲーム終了
    socket.on('end-game', ({ roomID }) => {
        const room = rooms[roomID];
        if (!room || room.users[0].socketId !== socket.id) return;

        room.status = 'result';
        io.to(roomID).emit('game-over', room);
    });

    // 6. もう一度遊ぶ（リセット）
    socket.on('reset-room', ({ roomID }) => {
        const room = rooms[roomID];
        if (!room || room.users[0].socketId !== socket.id) return;

        room.status = 'waiting';
        room.history = [];
        room.users.forEach(user => {
            user.inputWord = '';
            user.targetWord = '';
            user.giverName = '';
            user.outCount = 0;
            user.lastOutTime = 0;
        });

        io.to(roomID).emit('room-reseted', room);
    });

    // 7. 【修正・拡張】ユーザー切断時のホスト移譲ロジック
    socket.on('disconnect', () => {
        console.log('ユーザーが切断しました:', socket.id);

        // 全ての部屋をループして、切断したユーザーがいた部屋を探す
        Object.keys(rooms).forEach(roomID => {
            const room = rooms[roomID];
            const userIndex = room.users.findIndex(u => u.socketId === socket.id);

            if (userIndex !== -1) {
                const disconnectedUser = room.users[userIndex];
                // 部屋からユーザーを削除
                room.users.splice(userIndex, 1);
                console.log(`${disconnectedUser.name} が部屋 ${roomID} から退出しました。`);

                // 部屋にまだ誰か残っている場合
                if (room.users.length > 0) {
                    // もしプレイ中や結果画面なら、ログに残す
                    if (room.status === 'playing' || room.status === 'result') {
                        room.history.push(`${disconnectedUser.name}さんが退室しました。`);
                    }

                    // ユーザーリストが更新された（＝先頭が入れ替わったら自動で新ホストになる）ので全員に通知
                    // プレイ中ならゲーム画面、待機中なら待機画面をそれぞれ更新させる
                    if (room.status === 'waiting') {
                        io.to(roomID).emit('room-data', room);
                    } else if (room.status === 'playing') {
                        io.to(roomID).emit('game-updated', room);
                    } else if (room.status === 'result') {
                        // 結果画面のボタン状態を更新するため、ゲームオーバーイベントを再送
                        io.to(roomID).emit('game-over', room);
                    }
                } else {
                    // 部屋に誰一人いなくなったら部屋データを削除
                    delete rooms[roomID];
                    console.log(`部屋 ${roomID} は空になったため削除されました。`);
                }
            }
        });
    });
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`サーバーが起動しました: http://localhost:${PORT}`);
});