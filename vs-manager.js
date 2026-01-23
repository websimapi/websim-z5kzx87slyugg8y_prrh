import { room } from './leaderboard-api.js';

export class VSManager {
    constructor(game, ui) {
        this.game = game;
        this.ui = ui;
        this.state = 'idle'; // idle, seeking, connecting, counting_down, playing, ended
        this.opponent = null;
        this.matchId = null;
        this.countdownInterval = null;
        this.opponentCanvas = document.getElementById('opponent-canvas');
        this.ctx = this.opponentCanvas.getContext('2d');
        this.currentUser = null;
        
        // Game sync data
        this.lastPresenceUpdate = 0;
        
        this.latestPresence = {};
        this.targetOpponentId = null;

        // Initialization
        this.init();
    }

    async init() {
        this.currentUser = await window.websim.getCurrentUser();
        
        // Subscribe to presence for matchmaking and game state
        room.subscribePresence((presence) => {
            this.handlePresenceUpdate(presence);
        });

        room.subscribePresenceUpdateRequests((req, fromId) => {
            this.handlePresenceRequest(req, fromId);
        });

        // Start render loop for opponent view
        this.renderLoop();
    }

    resetState() {
        if (this.countdownInterval) {
            clearInterval(this.countdownInterval);
            this.countdownInterval = null;
        }
        this.opponent = null;
        this.opponentId = null;
        this.matchId = null;
        this.currentOpponentState = null;
        this.targetOpponentState = null;
        this.targetOpponentId = null;
        this.ui.resetVSUI();
    }

    startSeeking(targetId = null) {
        this.resetState();
        this.targetOpponentId = targetId; // Set after reset
        this.state = 'seeking';
        this.game.setMode('zen'); // Start Zen mode while waiting
        this.ui.updateVSStatus(targetId ? 'Challenging player...' : 'Searching for opponent...', true);
        
        room.updatePresence({
            status: 'seeking',
            vs_level: this.game.level,
            vs_mode_active: true,
            vs_health: 300,
            vs_score: 0
        });
    }

    directChallenge(targetId) {
        // Check if user is available in cached presence
        const targetData = this.latestPresence ? this.latestPresence[targetId] : null;
        
        // If target doesn't exist, isn't seeking, or isn't in VS mode, fail.
        if (!targetData || targetData.status !== 'seeking' || !targetData.vs_mode_active) {
            return false;
        }

        // Start seeking specifically for this user
        this.startSeeking(targetId);
        
        // Attempt match immediately with current data to avoid waiting for next tick
        if (this.latestPresence) {
            this.attemptMatchmaking(this.latestPresence);
        }
        return true;
    }

    cancelSeeking() {
        this.state = 'idle';
        this.game.setMode('standard');
        this.ui.updateVSStatus('', false);
        this.resetState();
        
        room.updatePresence({
            status: 'idle',
            vs_mode_active: false
        });
    }

    handlePresenceUpdate(presence) {
        this.latestPresence = presence;
        // Update Lobby UI (Title Screen)
        this.updateLobbyPreview(presence);

        if (this.state === 'seeking') {
            this.attemptMatchmaking(presence);
        } else if (this.state === 'playing' || this.state === 'counting_down') {
            this.syncGameState(presence);
        }
    }

    updateLobbyPreview(presence) {
        const lobbyUsers = [];
        const myId = room.clientId;

        Object.entries(presence).forEach(([clientId, data]) => {
            // Filter out myself
            if (clientId === myId) return;

            // Filter out non-VS users
            if (!data.vs_mode_active) return;

            // Only show users who are strictly waiting (seeking)
            // Busy users (playing/counting_down) are filtered out as requested
            if (data.status !== 'seeking') return;

            const peer = room.peers[clientId];
            if (peer) {
                lobbyUsers.push({
                    username: peer.username,
                    avatarUrl: peer.avatarUrl,
                    status: data.status,
                    clientId: clientId
                });
            }
        });

        this.ui.updateVSLobbyPreview(lobbyUsers);
    }

    attemptMatchmaking(presence) {
        const myId = room.clientId;
        const potentialOpponents = Object.entries(presence)
            .filter(([id, data]) => {
                return id !== myId && 
                       data.status === 'seeking' && 
                       data.vs_mode_active;
            });

        if (this.targetOpponentId) {
            // Targeted Challenge
            const target = potentialOpponents.find(p => p[0] === this.targetOpponentId);
            if (target) {
                const opponentId = target[0];
                this.initiateInvite(opponentId);
            }
        } else {
            // Auto Match
            if (potentialOpponents.length > 0) {
                // Sort by ID to ensure deterministic pairing
                potentialOpponents.sort((a, b) => a[0].localeCompare(b[0]));
                const opponentId = potentialOpponents[0][0];

                // Lower ID initiates the invite
                if (myId < opponentId) {
                    this.initiateInvite(opponentId);
                }
            }
        }
    }

    initiateInvite(opponentId) {
        this.state = 'connecting';
        const matchId = `${room.clientId}-${opponentId}-${Date.now()}`;
        room.requestPresenceUpdate(opponentId, { type: 'vs_invite', matchId: matchId });
    }

    handlePresenceRequest(req, fromId) {
        if (req.type === 'vs_invite' && this.state === 'seeking') {
            this.acceptMatch(fromId, req.matchId);
        } else if (req.type === 'vs_accept' && (this.state === 'connecting' || this.state === 'seeking')) {
            this.startMatch(fromId, req.matchId);
        } else if (req.type === 'vs_damage') {
             // Handled locally usually, but can enforce here
        } else if (req.type === 'vs_end') {
            if (this.state === 'playing') {
                this.endMatch('win'); // Opponent died/quit
            }
        }
    }

    acceptMatch(opponentId, matchId) {
        this.state = 'connecting';
        this.matchId = matchId;
        room.requestPresenceUpdate(opponentId, { type: 'vs_accept', matchId: matchId });
        this.startMatch(opponentId, matchId);
    }

    startMatch(opponentId, matchId) {
        this.opponent = room.peers[opponentId]; // { username, avatarUrl, ... }
        this.opponentId = opponentId;
        this.matchId = matchId;
        this.state = 'counting_down';
        
        // Clear any previous interpolation state
        this.currentOpponentState = null;
        this.targetOpponentState = null;

        this.ui.setupVSMatch(this.opponent);
        
        // Reset game for match
        this.game.setMode('vs');
        this.game.setDifficulty('easy'); // Ensure visuals are easy during countdown
        this.game.reset(); // Resets local state
        
        // Initial VS State (Counting Down)
        room.updatePresence({
            status: 'counting_down',
            matchId: matchId,
            vs_health: 300,
            vs_level: 1,
            vs_score: 0,
            vs_angle: 0,
            vs_targetStart: 0,
            vs_targetSize: 0.4
        });

        // Countdown
        let count = 3;
        this.ui.updateVSStatus(`Starting in ${count}...`, true);
        
        if (this.countdownInterval) clearInterval(this.countdownInterval);
        
        this.countdownInterval = setInterval(() => {
            count--;
            if (count > 0) {
                this.ui.updateVSStatus(`Starting in ${count}...`, true);
            } else {
                clearInterval(this.countdownInterval);
                this.countdownInterval = null;
                
                this.state = 'playing';
                
                // Update presence to playing
                room.updatePresence({
                    status: 'playing',
                    vs_health: 300 // Re-assert health just in case
                });

                this.ui.updateVSStatus('FIGHT!', true);
                setTimeout(() => this.ui.updateVSStatus('', false), 1000);
                this.game.start('easy', { 
                    username: this.opponent.username, 
                    avatarUrl: this.opponent.avatarUrl 
                }); 
            }
        }, 1000);
    }

    syncGameState(presence) {
        if (!this.opponentId || !presence[this.opponentId]) {
            // Opponent disconnected
            if (this.state === 'playing') {
                this.endMatch('win');
            }
            return;
        }

        const oppData = presence[this.opponentId];
        
        // Validate Opponent State to prevent stale data leaks (e.g. reading Zen mode levels)
        // We only trust data if they are in the same match AND in a valid VS state
        const isValidOpponent = (oppData.status === 'playing' || oppData.status === 'counting_down') &&
                                oppData.matchId === this.matchId;

        // Default values if opponent isn't ready yet
        let oppHealth = 300;
        let oppLevel = 1;
        let oppScore = 0;
        let oppAngle = 0;
        let oppTargetStart = 0;
        let oppTargetSize = 0.4;

        if (isValidOpponent) {
            oppHealth = oppData.vs_health !== undefined ? oppData.vs_health : 300;
            oppLevel = oppData.vs_level || 1;
            oppScore = oppData.vs_score || 0;
            oppAngle = oppData.vs_angle || 0;
            oppTargetStart = oppData.vs_targetStart || 0;
            oppTargetSize = oppData.vs_targetSize || 0.4;
        }

        if (this.state === 'counting_down') {
            oppHealth = 300; // Force full health during countdown
        }
        
        // Update opponent UI
        this.ui.updateOpponentHearts(oppHealth);
        this.ui.updateOpponentScore(oppScore);
        this.ui.updateOpponentLevel(oppLevel);
        
        // Logic for drain
        if (this.state === 'playing') {
            // Only apply drain if opponent is valid (prevents draining against a ghost/laggy player)
            if (isValidOpponent) {
                this.game.setOpponentLevel(oppLevel);
                
                // Check if opponent died
                if (oppHealth <= 0) {
                    this.endMatch('win');
                }
            }
        }

        // Store target render data for interpolation
        this.targetOpponentState = {
            angle: oppAngle,
            targetStart: oppTargetStart,
            targetSize: oppTargetSize,
            level: oppLevel,
            score: oppScore,
            health: oppHealth
        };

        // Initialize current state if not set
        if (!this.currentOpponentState) {
            this.currentOpponentState = { ...this.targetOpponentState };
        }
    }

    updateGameLoop(deltaTime) {
        if (this.state !== 'playing') return;

        // Interpolate Opponent State
        if (this.targetOpponentState && this.currentOpponentState) {
            // Lerp angle correctly handling wrap-around
            const currentAngle = this.currentOpponentState.angle;
            const targetAngle = this.targetOpponentState.angle;
            
            let diff = targetAngle - currentAngle;
            // Normalize diff to -PI to PI
            while (diff < -Math.PI) diff += Math.PI * 2;
            while (diff > Math.PI) diff -= Math.PI * 2;

            const lerpFactor = Math.min(deltaTime * 10, 1); // Approx 10Hz sync
            
            this.currentOpponentState.angle += diff * lerpFactor;
            
            // Snap other values (targets usually jump)
            this.currentOpponentState.targetStart = this.targetOpponentState.targetStart;
            this.currentOpponentState.targetSize = this.targetOpponentState.targetSize;
            this.currentOpponentState.level = this.targetOpponentState.level;
            this.currentOpponentState.score = this.targetOpponentState.score;
            this.currentOpponentState.health = this.targetOpponentState.health;

            // Update Game's view of opponent for Replay recording
            this.game.opponentState = { ...this.currentOpponentState };
        }

        // Broadcast my state occasionally (e.g. 10Hz) or on critical change
        const now = performance.now();
        if (now - this.lastPresenceUpdate > 100) {
            room.updatePresence({
                vs_health: this.game.health,
                vs_level: this.game.level,
                vs_score: this.game.score,
                vs_angle: this.game.angle,
                vs_targetStart: this.game.targetStartAngle,
                vs_targetSize: this.game.targetSize
            });
            this.lastPresenceUpdate = now;
        }

        // Check loss condition
        if (this.game.health <= 0) {
            this.endMatch('loss');
        }
    }

    endMatch(result) { // 'win' or 'loss'
        if (this.state === 'ended') return;
        this.state = 'ended';
        const opponentName = this.opponent ? this.opponent.username : 'Unknown';

        this.game.gameOver(
            result === 'win' ? 'You Win!' : 'You Died', 
            result,
            opponentName
        );
        
        room.updatePresence({
            status: 'idle',
            vs_mode_active: false
        });
        
        if (this.opponentId) {
            room.requestPresenceUpdate(this.opponentId, { type: 'vs_end' });
        }
    }

    renderLoop() {
        requestAnimationFrame(() => this.renderLoop());
        
        const d = this.currentOpponentState || this.opponentRenderData;
        if (!d) return;

        const ctx = this.ctx;
        const w = this.opponentCanvas.width;
        const h = this.opponentCanvas.height;
        const cx = w/2;
        const cy = h/2;
        const r = w * 0.4;
        const lw = 6;

        ctx.clearRect(0, 0, w, h);

        // Track
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI*2);
        ctx.strokeStyle = '#0f3460';
        ctx.lineWidth = lw;
        ctx.stroke();

        // Target
        if (d.targetSize > 0) {
            ctx.beginPath();
            ctx.arc(cx, cy, r, d.targetStart, d.targetStart + d.targetSize);
            ctx.strokeStyle = '#4CAF50';
            ctx.lineWidth = lw;
            ctx.lineCap = 'round';
            ctx.stroke();
        }

        // Cursor
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(d.angle);
        ctx.beginPath();
        ctx.moveTo(0, -r + lw/2);
        ctx.lineTo(0, -r - lw/2);
        ctx.strokeStyle = '#e94560';
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.restore();
    }
}