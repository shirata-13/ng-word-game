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
                status: 'waiting', // waiting / targeting / playing / result
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
            targetUserSocketId: '', // 自分がワードを書く対象のSocketID
            targetUserName: '',     // 自分がワードを書く対象の名前
            inputWord: '',          // 自分が「ターゲットに向けて」考えたワード
            targetWord: '',         // 自分に設定されたNGワード
            giverName: '',          // 自分のNGワードを考えた人の名前
            outCount: 0,
            lastOutTime: 0
        });

        io.to(roomID).emit('room-data', rooms[roomID]);
    });

    // 2. 【新規】ホストが「メンバー確定（ターゲット割り振振）」を押したとき
    socket.on('assign-targets', ({ roomID }) => {
        const room = rooms[roomID];
        if (!room || room.users.length < 2) return;
        if (room.users[0].socketId !== socket.id) return; // ホスト制限

        room.status = 'targeting';

        // 席替え方式で「誰が誰宛てに書くか」のペアを先に決める
        // ユーザーAはユーザーB宛て、BはC宛て、CはA宛てに書く
        const len = room.users.length;
        for (let i = 0; i < len; i++) {
            const nextIndex = (i + 1) % len;
            room.users[i].targetUserSocketId = room.users[nextIndex].socketId;
            room.users[i].targetUserName = room.users[nextIndex].name;
        }

        // 全員にターゲット決定（入力フェーズ開始）を通知
        io.to(roomID).emit('targets-assigned', room);
    });

    // 3. 【修正】ワードの提出（ターゲットへ直接NGワードとして書き込む）
    socket.on('submit-word', ({ roomID, word }) => {
        const room = rooms[roomID];
        if (!room) return;

        // 1. まず自分の入力状態を保存
        const myUser = room.users.find(u => u.socketId === socket.id);
        if (myUser) {
            myUser.inputWord = word;

            // 2. 自分が書く対象（ターゲット）を探して、その人の「targetWord」と「giverName」に直接代入！
            const targetUser = room.users.find(u => u.socketId === myUser.targetUserSocketId);
            if (targetUser) {
                targetUser.targetWord = word;
                targetUser.giverName = myUser.name; // 考案者は自分
            }
        }

        // 全員の入力が完了したかチェック（wordがリセット用の空文字ではないことを確認）
        const allSubmitted = room.users.every(u => u.inputWord !== '');

        // 状態を全員に通知（「入力済」のチェックマーク反映用）
        io.to(roomID).emit('room-data', room);
    });

    // 4. 【修正】ゲーム開始（すでに割り当ては終わっているので、ステータスを playing に変えるだけ）
    socket.on('start-game', ({ roomID }) => {
        const room = rooms[roomID];
        if (!room || room.users.length < 2) return;
        if (room.users[0].socketId !== socket.id) return; // ホスト制限

        room.status = 'playing';
        room.history = [];

        // カウント等の初期化
        room.users.forEach(u => {
            u.outCount = 0;
            u.lastOutTime = 0;
        });

        io.to(roomID).emit('game-started', room);
    });

    // 5. 「言っちゃった」ボタン（変更なし）
    socket.on('say-ng-word', ({ roomID, targetSocketId, actorName }) => {
        const room = rooms[roomID];
        if (!room || room.status !== 'playing') return;

        const targetUser = room.users.find(u => u.socketId === targetSocketId);
        if (targetUser) {
            const currentTime = Date.now();
            const cooldown = 60 * 1000;

            if (currentTime - targetUser.lastOutTime < cooldown) return;

            targetUser.outCount += 1;
            targetUser.lastOutTime = currentTime;

            const logMessage = `${targetUser.name}さんがNGワード「${targetUser.targetWord}」を言っちゃいました！（指摘: ${actorName}）※次の1分間はカウントされません`;
            room.history.push(logMessage);

            io.to(roomID).emit('game-updated', room);
        }
    });

    // 6. ゲーム終了（変更なし）
    socket.on('end-game', ({ roomID }) => {
        const room = rooms[roomID];
        if (!room || room.users[0].socketId !== socket.id) return;

        room.status = 'result';
        io.to(roomID).emit('game-over', room);
    });

    // 7. もう一度遊ぶ（リセット・変更なし）
    socket.on('reset-room', ({ roomID }) => {
        const room = rooms[roomID];
        if (!room || room.users[0].socketId !== socket.id) return;

        room.status = 'waiting';
        room.history = [];
        room.users.forEach(user => {
            user.inputWord = '';
            user.targetWord = '';
            user.targetUserSocketId = '';
            user.targetUserName = '';
            user.giverName = '';
            user.outCount = 0;
            user.lastOutTime = 0;
        });

        io.to(roomID).emit('room-reseted', room);
    });

    // 8. ユーザー切断時のホスト移譲（変更なし）
    socket.on('disconnect', () => {
        console.log('ユーザーが切断しました:', socket.id);
        Object.keys(rooms).forEach(roomID => {
            const room = rooms[roomID];
            const userIndex = room.users.findIndex(u => u.socketId === socket.id);

            if (userIndex !== -1) {
                const disconnectedUser = room.users[userIndex];
                room.users.splice(userIndex, 1);

                if (room.users.length > 0) {
                    if (room.status === 'playing' || room.status === 'result') {
                        room.history.push(`${disconnectedUser.name}さんが退室しました。`);
                    }

                    if (room.status === 'waiting' || room.status === 'targeting') {
                        io.to(roomID).emit('room-data', room);
                    } else if (room.status === 'playing') {
                        io.to(roomID).emit('game-updated', room);
                    } else if (room.status === 'result') {
                        io.to(roomID).emit('game-over', room);
                    }
                } else {
                    delete rooms[roomID];
                }
            }
        });
    });
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`サーバーが起動しました: http://localhost:${PORT}`);
});