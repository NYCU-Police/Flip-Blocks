-- Flip Blocks / 翻轉方塊 / 블록 뒤집기
-- Main.lua
-- Codea rewrite: no erosion version + surrounded group capture
--
-- Core model:
-- 1) Board starts fully filled, half vs half.
-- 2) Player color owns the bottom half at start.
-- 3) Bot color owns the top half at start.
-- 4) Active pieces move until their next step would touch their own color.
-- 5) No erosion. A locked piece only paints its own occupied cells.
-- 6) Fake bot only auto advances. No AI movement/rotation.
-- 7) NEW: Surrounded groups become dead stones and flip color.
--
-- Coordinate note:
-- y=1 is bottom row
-- y=ROWS is top row

math.randomseed(os.time())

local COLS, ROWS = 10, 20

local PLAYER = 1
local BOT = 2

local STATE_START = 1
local STATE_MATCH = 2
local STATE_PLAYING = 3
local STATE_GAMEOVER = 4

local SHAPES = {
    I = {
        {{0,1},{1,1},{2,1},{3,1}},
        {{2,0},{2,1},{2,2},{2,3}},
        {{0,2},{1,2},{2,2},{3,2}},
        {{1,0},{1,1},{1,2},{1,3}},
    },
    O = {
        {{1,0},{2,0},{1,1},{2,1}},
        {{1,0},{2,0},{1,1},{2,1}},
        {{1,0},{2,0},{1,1},{2,1}},
        {{1,0},{2,0},{1,1},{2,1}},
    },
    T = {
        {{1,0},{0,1},{1,1},{2,1}},
        {{1,0},{1,1},{2,1},{1,2}},
        {{0,1},{1,1},{2,1},{1,2}},
        {{1,0},{0,1},{1,1},{1,2}},
    },
    S = {
        {{1,0},{2,0},{0,1},{1,1}},
        {{1,0},{1,1},{2,1},{2,2}},
        {{1,1},{2,1},{0,2},{1,2}},
        {{0,0},{0,1},{1,1},{1,2}},
    },
    Z = {
        {{0,0},{1,0},{1,1},{2,1}},
        {{2,0},{1,1},{2,1},{1,2}},
        {{0,1},{1,1},{1,2},{2,2}},
        {{1,0},{0,1},{1,1},{0,2}},
    },
    J = {
        {{0,0},{0,1},{1,1},{2,1}},
        {{1,0},{2,0},{1,1},{1,2}},
        {{0,1},{1,1},{2,1},{2,2}},
        {{1,0},{1,1},{0,2},{1,2}},
    },
    L = {
        {{2,0},{0,1},{1,1},{2,1}},
        {{1,0},{1,1},{1,2},{2,2}},
        {{0,1},{1,1},{2,1},{0,2}},
        {{0,0},{1,0},{1,1},{1,2}},
    }
}

local SHAPE_KEYS = {"I","O","T","S","Z","J","L"}

local state = STATE_START
local board = {}
local ui = {}

local playerPiece = nil
local botPiece = nil
local playerQueue = {}
local botQueue = {}

local selectedColor = "black"
local fakeBotEnabled = false
local winnerText = ""

local boardX, boardY, boardW, boardH, cellSize = 0, 0, 0, 0, 0

local dropTimerPlayer = 0
local dropTimerBot = 0
local baseDrop = 0.45
local softDrop = 0.08
local playerFast = false
local botFast = false

local sides = {
    player = {
        colorName = "black",
        colorValue = 1,
        dir = -1,
        spawnY = ROWS + 1
    },
    bot = {
        colorName = "white",
        colorValue = 2,
        dir = 1,
        spawnY = -3
    }
}

local function randShape()
    return SHAPE_KEYS[math.random(1, #SHAPE_KEYS)]
end

local function fillQueue(q)
    while #q < 3 do
        q[#q + 1] = randShape()
    end
end

local function chooseSides(choice)
    selectedColor = choice

    if choice == "black" then
        -- 玩家：黑色，下半部基地，方塊從上往下
        sides.player = {
            colorName = "black",
            colorValue = 1,
            dir = -1,
            spawnY = ROWS + 1
        }

        -- 假人：白色，上半部基地，方塊從下往上
        sides.bot = {
            colorName = "white",
            colorValue = 2,
            dir = 1,
            spawnY = -3
        }
    else
        -- 玩家：白色，下半部基地，方塊從下往上
        sides.player = {
            colorName = "white",
            colorValue = 2,
            dir = 1,
            spawnY = -3
        }

        -- 假人：黑色，上半部基地，方塊從上往下
        sides.bot = {
            colorName = "black",
            colorValue = 1,
            dir = -1,
            spawnY = ROWS + 1
        }
    end
end

local function initBoard()
    board = {}
    local half = ROWS / 2
    local bottomColor = sides.player.colorValue
    local topColor = sides.bot.colorValue

    for y = 1, ROWS do
        board[y] = {}
        for x = 1, COLS do
            if y <= half then
                board[y][x] = bottomColor
            else
                board[y][x] = topColor
            end
        end
    end
end

local function pieceInfo(owner)
    return (owner == PLAYER) and sides.player or sides.bot
end

local function makePiece(owner, shapeKey)
    local info = pieceInfo(owner)
    return {
        owner = owner,
        shape = shapeKey,
        rot = 1,
        x = 4,
        y = info.spawnY,
        dir = info.dir,
        colorValue = info.colorValue
    }
end

local function inBounds(x, y)
    return x >= 1 and x <= COLS and y >= 1 and y <= ROWS
end

local function pieceCells(piece, x, y, rot)
    local cells = {}
    if not piece or not piece.shape then
        return cells
    end

    local px = x or piece.x
    local py = y or piece.y
    local pr = rot or piece.rot

    local set = SHAPES[piece.shape]
    if not set or not set[pr] then
        return cells
    end

    for _, p in ipairs(set[pr]) do
        cells[#cells + 1] = {x = px + p[1], y = py + p[2]}
    end

    return cells
end

local function nextY(piece)
    return piece.y + piece.dir
end

local function pieceTouchesOwnColor(piece, testY)
    for _, c in ipairs(pieceCells(piece, piece.x, testY, piece.rot)) do
        if inBounds(c.x, c.y) and board[c.y][c.x] == piece.colorValue then
            return true
        end
    end
    return false
end

local function pieceHasAnyInBoardCell(piece, testX, testY, testRot)
    for _, c in ipairs(pieceCells(piece, testX, testY, testRot)) do
        if inBounds(c.x, c.y) then
            return true
        end
    end
    return false
end

local function canStayAt(piece, testX, testY, testRot)
    for _, c in ipairs(pieceCells(piece, testX, testY, testRot)) do
        if c.x < 1 or c.x > COLS then
            return false
        end
    end
    return true
end

local function canAdvance(piece)
    local ny = nextY(piece)

    if not canStayAt(piece, piece.x, ny, piece.rot) then
        return false
    end

    if pieceTouchesOwnColor(piece, ny) then
        return false
    end

    return true
end

local function movePiece(piece, dx)
    if not piece then
        return
    end
    local tx = piece.x + dx
    if canStayAt(piece, tx, piece.y, piece.rot) then
        piece.x = tx
    end
end

local function rotatePiece(piece)
    if not piece then
        return
    end

    local nr = piece.rot % 4 + 1
    local kicks = {0, -1, 1, -2, 2}

    for _, k in ipairs(kicks) do
        local tx = piece.x + k
        if canStayAt(piece, tx, piece.y, nr) then
            piece.x = tx
            piece.rot = nr
            return
        end
    end
end

local function countBoard()
    local black, white = 0, 0
    for y = 1, ROWS do
        for x = 1, COLS do
            local v = board[y][x]
            if v == 1 then
                black = black + 1
            elseif v == 2 then
                white = white + 1
            end
        end
    end
    return black, white
end

local function countRowsOfColor(colorValue)
    local rowsOwned = 0
    for y = 1, ROWS do
        local full = true
        for x = 1, COLS do
            if board[y][x] ~= colorValue then
                full = false
                break
            end
        end
        if full then
            rowsOwned = rowsOwned + 1
        end
    end
    return rowsOwned
end

local function checkEndState()
    local black, white = countBoard()
    local total = COLS * ROWS

    if black / total >= 0.70 then
        winnerText = (sides.player.colorValue == 1) and "玩家獲勝" or "假人獲勝"
        state = STATE_GAMEOVER
        return
    end

    if white / total >= 0.70 then
        winnerText = (sides.player.colorValue == 2) and "玩家獲勝" or "假人獲勝"
        state = STATE_GAMEOVER
        return
    end

    local blackRows = countRowsOfColor(1)
    local whiteRows = countRowsOfColor(2)

    if blackRows == ROWS then
        winnerText = (sides.player.colorValue == 1) and "玩家獲勝" or "假人獲勝"
        state = STATE_GAMEOVER
        return
    end

    if whiteRows == ROWS then
        winnerText = (sides.player.colorValue == 2) and "玩家獲勝" or "假人獲勝"
        state = STATE_GAMEOVER
        return
    end
end

-- ========= NEW: surrounded group / dead stone logic =========

local function sideForColor(colorValue)
    if sides.player.colorValue == colorValue then
        return sides.player
    end
    return sides.bot
end

local function homeRowForColor(colorValue)
    local side = sideForColor(colorValue)
    -- dir = -1 means piece falls from top toward bottom, so home base is bottom row y=1
    -- dir =  1 means piece rises from bottom toward top, so home base is top row y=ROWS
    if side.dir == -1 then
        return 1
    else
        return ROWS
    end
end

local function otherColor(colorValue)
    return (colorValue == 1) and 2 or 1
end

local function cellKey(x, y)
    return tostring(x) .. ":" .. tostring(y)
end

local function collectGroup(startX, startY, colorValue, visited)
    local q = {{x = startX, y = startY}}
    local qi = 1
    local group = {}
    local touchesHome = false
    local homeRow = homeRowForColor(colorValue)

    visited[cellKey(startX, startY)] = true

    while qi <= #q do
        local cur = q[qi]
        qi = qi + 1

        group[#group + 1] = cur

        if cur.y == homeRow then
            touchesHome = true
        end

        local dirs = {
            {1, 0}, {-1, 0}, {0, 1}, {0, -1}
        }

        for _, d in ipairs(dirs) do
            local nx = cur.x + d[1]
            local ny = cur.y + d[2]

            if inBounds(nx, ny) and board[ny][nx] == colorValue then
                local k = cellKey(nx, ny)
                if not visited[k] then
                    visited[k] = true
                    q[#q + 1] = {x = nx, y = ny}
                end
            end
        end
    end

    return group, touchesHome
end

local function collectDeadGroups(defenderColor)
    local visited = {}
    local deadGroups = {}

    for y = 1, ROWS do
        for x = 1, COLS do
            if board[y][x] == defenderColor then
                local k = cellKey(x, y)
                if not visited[k] then
                    local group, touchesHome = collectGroup(x, y, defenderColor, visited)

                    if not touchesHome then
                        deadGroups[#deadGroups + 1] = group
                    end
                end
            end
        end
    end

    return deadGroups
end

local function flipGroups(groups, newColor)
    local flipped = 0

    for _, group in ipairs(groups) do
        for _, c in ipairs(group) do
            if board[c.y][c.x] ~= newColor then
                board[c.y][c.x] = newColor
                flipped = flipped + 1
            end
        end
    end

    return flipped
end

local function resolveCaptures(attackerColor)
    local defenderColor = otherColor(attackerColor)
    local totalFlipped = 0

    -- repeat until stable, so chain captures can complete
    while true do
        local deadGroups = collectDeadGroups(defenderColor)
        local flipped = flipGroups(deadGroups, attackerColor)
        totalFlipped = totalFlipped + flipped

        if flipped == 0 then
            break
        end
    end

    return totalFlipped
end

-- ========= end NEW logic =========

local function lockPiece(piece)
    for _, c in ipairs(pieceCells(piece)) do
        if inBounds(c.x, c.y) then
            board[c.y][c.x] = piece.colorValue
        end
    end

    resolveCaptures(piece.colorValue)
    checkEndState()
end

local function spawnPiece(owner)
    if state ~= STATE_PLAYING then
        return
    end

    if owner == PLAYER then
        fillQueue(playerQueue)
        local shapeKey = table.remove(playerQueue, 1)
        fillQueue(playerQueue)
        playerPiece = makePiece(PLAYER, shapeKey)
    else
        fillQueue(botQueue)
        local shapeKey = table.remove(botQueue, 1)
        fillQueue(botQueue)
        botPiece = makePiece(BOT, shapeKey)
    end
end

local function stepPiece(piece)
    if not piece or state ~= STATE_PLAYING then
        return
    end

    if canAdvance(piece) then
        piece.y = nextY(piece)
    else
        if pieceHasAnyInBoardCell(piece, piece.x, piece.y, piece.rot) then
            lockPiece(piece)
        end

        if state ~= STATE_PLAYING then
            return
        end

        if piece.owner == PLAYER then
            spawnPiece(PLAYER)
        else
            spawnPiece(BOT)
        end
    end
end

local function hardDropPiece(piece)
    if not piece or state ~= STATE_PLAYING then
        return
    end

    while canAdvance(piece) do
        piece.y = nextY(piece)
    end

    if pieceHasAnyInBoardCell(piece, piece.x, piece.y, piece.rot) then
        lockPiece(piece)
    end

    if state ~= STATE_PLAYING then
        return
    end

    if piece.owner == PLAYER then
        spawnPiece(PLAYER)
    else
        spawnPiece(BOT)
    end
end

local function layoutUI()
    boardH = HEIGHT * 0.58
    cellSize = math.floor(math.min(WIDTH * 0.60 / COLS, boardH / ROWS))
    boardW = cellSize * COLS
    boardH = cellSize * ROWS
    boardX = (WIDTH - boardW) * 0.5
    boardY = HEIGHT * 0.15

    local by = HEIGHT * 0.055
    local gap = WIDTH * 0.02
    local bs = math.min(WIDTH * 0.16, 90)
    local startX = (WIDTH - (bs * 5 + gap * 4)) * 0.5 + bs * 0.5

    ui.leftBtn     = {x = startX + (bs + gap) * 0, y = by, w = bs, h = bs, label = "←"}
    ui.rightBtn    = {x = startX + (bs + gap) * 1, y = by, w = bs, h = bs, label = "→"}
    ui.rotBtn      = {x = startX + (bs + gap) * 2, y = by, w = bs, h = bs, label = "⟳"}
    ui.downBtn     = {x = startX + (bs + gap) * 3, y = by, w = bs, h = bs, label = "↓"}
    ui.hardDropBtn = {x = startX + (bs + gap) * 4, y = by, w = bs, h = bs, label = "⇣"}

    ui.startBtn    = {x = WIDTH * 0.50, y = HEIGHT * 0.42, w = WIDTH * 0.44, h = 64, label = "開始遊戲"}
    ui.backBtn     = {x = WIDTH * 0.20, y = HEIGHT * 0.14, w = WIDTH * 0.22, h = 50, label = "返回"}
    ui.blackBtn    = {x = WIDTH * 0.32, y = HEIGHT * 0.58, w = WIDTH * 0.26, h = 58, label = "選黑色"}
    ui.whiteBtn    = {x = WIDTH * 0.68, y = HEIGHT * 0.58, w = WIDTH * 0.26, h = 58, label = "選白色"}
    ui.fakeBotBtn  = {x = WIDTH * 0.50, y = HEIGHT * 0.40, w = WIDTH * 0.50, h = 64, label = "生成假人開始"}
    ui.restartBtn  = {x = WIDTH * 0.50, y = HEIGHT * 0.30, w = WIDTH * 0.34, h = 60, label = "再玩一次"}
end

local function pointInButton(btn, x, y)
    return btn
        and x >= btn.x - btn.w / 2 and x <= btn.x + btn.w / 2
        and y >= btn.y - btn.h / 2 and y <= btn.y + btn.h / 2
end

local function drawButton(btn, bg, fg)
    if not btn then
        return
    end

    pushStyle()
    rectMode(CENTER)
    stroke(255,255,255,45)
    strokeWidth(2)
    fill(bg)
    rect(btn.x, btn.y, btn.w, btn.h, 12)
    fill(fg)
    fontSize(math.min(btn.h * 0.38, 28))
    text(btn.label, btn.x, btn.y)
    popStyle()
end

local function boardToScreen(x, y)
    return boardX + (x - 1) * cellSize, boardY + (y - 1) * cellSize
end

local function cellColor(v)
    if v == 1 then
        return color(18, 18, 22)
    elseif v == 2 then
        return color(250, 250, 252)
    else
        return color(0, 0, 0, 0)
    end
end

local function drawBoard()
    pushStyle()
    rectMode(CORNER)
    noStroke()
    fill(240, 241, 245)
    rect(boardX - 8, boardY - 8, boardW + 16, boardH + 16, 14)

    for y = 1, ROWS do
        for x = 1, COLS do
            local sx, sy = boardToScreen(x, y)
            local c = cellColor(board[y][x])

            stroke(140, 140, 150, 70)
            strokeWidth(1)
            fill(c.r, c.g, c.b, 255)
            rect(sx, sy, cellSize, cellSize)
        end
    end

    stroke(255, 120, 120, 180)
    strokeWidth(3)
    local midY = boardY + (ROWS / 2) * cellSize
    line(boardX, midY, boardX + boardW, midY)

    popStyle()
end

local function drawPiece(piece)
    if not piece then
        return
    end

    for _, c in ipairs(pieceCells(piece)) do
        if inBounds(c.x, c.y) then
            local sx, sy = boardToScreen(c.x, c.y)
            local base = cellColor(piece.colorValue)

            pushStyle()
            rectMode(CORNER)
            stroke(255, 180, 60, 180)
            strokeWidth(2)
            fill(base.r, base.g, base.b, 185)
            rect(sx + 1, sy + 1, cellSize - 2, cellSize - 2, 4)
            popStyle()
        end
    end
end

local function drawPreviewBox(cx, cy, title, shapeKey, colorValue)
    local box = cellSize * 4.5

    pushStyle()
    rectMode(CENTER)
    fill(247,247,249)
    stroke(225,225,229)
    rect(cx, cy, box, box, 10)

    fill(60)
    fontSize(16)
    text(title, cx, cy + box * 0.42)

    if shapeKey and SHAPES[shapeKey] then
        local mini = cellSize * 0.55
        local shape = SHAPES[shapeKey][1]
        local cc = cellColor(colorValue)

        for _, p in ipairs(shape) do
            local px = cx - box * 0.28 + p[1] * mini
            local py = cy - box * 0.20 + p[2] * mini
            fill(cc)
            stroke(150,150,155)
            rect(px, py, mini - 2, mini - 2, 3)
        end
    end

    popStyle()
end

local function drawTopBar()
    local black, white = countBoard()
    local total = COLS * ROWS
    local blackPct = black / total
    local whitePct = white / total

    local x, y, w, h = WIDTH * 0.08, HEIGHT * 0.93, WIDTH * 0.84, 22

    pushStyle()
    rectMode(CORNER)

    fill(235)
    noStroke()
    rect(x, y, w, h, 10)

    fill(28, 28, 34)
    rect(x, y, w * blackPct, h, 10)

    fill(244, 244, 246)
    rect(x + w * blackPct, y, w * whitePct, h, 10)

    stroke(100,100,105)
    noFill()
    rect(x, y, w, h, 10)

    stroke(255,80,80)
    line(x + w * 0.70, y - 3, x + w * 0.70, y + h + 3)

    fill(30)
    fontSize(14)
    textAlign(LEFT)
    text(string.format("Black %.0f%%", blackPct * 100), x, y + h + 14)
    textAlign(RIGHT)
    text(string.format("White %.0f%%", whitePct * 100), x + w, y + h + 14)
    textAlign(CENTER)

    popStyle()
end

local function drawHUD()
    drawTopBar()

    local py = boardY + boardH + cellSize * 2.4
    drawPreviewBox(WIDTH * 0.22, py, "Next", playerQueue[1], sides.player.colorValue)
    drawPreviewBox(WIDTH * 0.78, py, "Next 2", playerQueue[2], sides.player.colorValue)

    pushStyle()
    fill(45)
    fontSize(16)

    local pDir = (sides.player.dir == -1) and "↓" or "↑"
    local bDir = (sides.bot.dir == -1) and "↓" or "↑"

    text("你: " .. (sides.player.colorName == "black" and "黑色 " or "白色 ") .. pDir, WIDTH * 0.22, py + cellSize * 2.7)
    text("假人: " .. (sides.bot.colorName == "black" and "黑色 " or "白色 ") .. bDir, WIDTH * 0.78, py + cellSize * 2.7)
    popStyle()

    drawButton(ui.leftBtn, color(35,35,40,220), color(255))
    drawButton(ui.rightBtn, color(35,35,40,220), color(255))
    drawButton(ui.rotBtn, color(230,230,235,240), color(30))
    drawButton(ui.downBtn, playerFast and color(180,230,220,255) or color(230,230,235,240), color(30))
    drawButton(ui.hardDropBtn, color(255,230,180,255), color(30))
end

local function drawStartScreen()
    background(245,246,248)

    pushStyle()
    fill(30)
    fontSize(34)
    text("翻轉方塊", WIDTH * 0.5, HEIGHT * 0.72)

    fontSize(18)
    text("Flip Blocks / 블록 뒤집기", WIDTH * 0.5, HEIGHT * 0.67)

    fontSize(16)
    fill(80)
    text("第一頁：開始畫面", WIDTH * 0.5, HEIGHT * 0.58)
    text("第二頁：區域網路配對", WIDTH * 0.5, HEIGHT * 0.54)
    text("目前可用假人測試核心玩法", WIDTH * 0.5, HEIGHT * 0.50)
    popStyle()

    drawButton(ui.startBtn, color(35,35,40), color(255))
end

local function drawMatchScreen()
    background(245,246,248)

    pushStyle()
    fill(30)
    fontSize(30)
    text("區域網路配對", WIDTH * 0.5, HEIGHT * 0.78)

    fontSize(17)
    fill(80)
    text("正式 LAN 功能先保留", WIDTH * 0.5, HEIGHT * 0.71)
    text("目前可選顏色並生成假人開始", WIDTH * 0.5, HEIGHT * 0.67)

    fontSize(16)
    local pickText = "目前選擇：" .. (selectedColor == "black" and "黑色" or "白色")
    text(pickText, WIDTH * 0.5, HEIGHT * 0.50)

    fontSize(15)
    text("黑色：底部黑基地，玩家方塊從上往下", WIDTH * 0.5, HEIGHT * 0.31)
    text("白色：底部白基地，玩家方塊從下往上", WIDTH * 0.5, HEIGHT * 0.27)
    popStyle()

    local blackBg = (selectedColor == "black") and color(20,20,24) or color(70,70,78)
    local whiteBg = (selectedColor == "white") and color(255,255,255) or color(235,235,240)

    drawButton(ui.blackBtn, blackBg, color(255))
    drawButton(ui.whiteBtn, whiteBg, color(30))
    drawButton(ui.fakeBotBtn, color(80,160,120), color(255))
    drawButton(ui.backBtn, color(220,220,225), color(30))
end

local function drawGameOver()
    pushStyle()
    rectMode(CORNER)
    noStroke()
    fill(0,0,0,150)
    rect(0,0,WIDTH,HEIGHT)

    fill(255)
    fontSize(30)
    text(winnerText, WIDTH * 0.5, HEIGHT * 0.58)

    fontSize(17)
    text("點再玩一次回到開始畫面", WIDTH * 0.5, HEIGHT * 0.53)
    drawButton(ui.restartBtn, color(250,250,252), color(25))
    popStyle()
end

local function resetGame()
    initBoard()

    playerQueue = {}
    botQueue = {}
    fillQueue(playerQueue)
    fillQueue(botQueue)

    playerPiece = nil
    botPiece = nil
    dropTimerPlayer = 0
    dropTimerBot = 0
    playerFast = false
    botFast = false
    winnerText = ""
    fakeBotEnabled = true
    state = STATE_PLAYING

    spawnPiece(PLAYER)
    spawnPiece(BOT)
end

function setup()
    if displayMode and FULLSCREEN then
        pcall(function() displayMode(FULLSCREEN) end)
    end

    layoutUI()
    chooseSides("black")
    state = STATE_START
end

function resize()
    layoutUI()
end

function orientationChanged()
    layoutUI()
end

local function updateGame(dt)
    if state ~= STATE_PLAYING then
        return
    end

    dropTimerPlayer = dropTimerPlayer + dt
    if dropTimerPlayer >= (playerFast and softDrop or baseDrop) then
        dropTimerPlayer = 0
        stepPiece(playerPiece)
    end

    if fakeBotEnabled then
        dropTimerBot = dropTimerBot + dt
        if dropTimerBot >= (botFast and softDrop or baseDrop) then
            dropTimerBot = 0
            stepPiece(botPiece)
            botFast = false
        end
    end
end

function draw()
    if not ui.startBtn then
        layoutUI()
    end

    background(250,250,252)

    if state == STATE_START then
        drawStartScreen()
        return
    end

    if state == STATE_MATCH then
        drawMatchScreen()
        return
    end

    updateGame(DeltaTime or 0)

    drawBoard()
    drawPiece(playerPiece)
    drawPiece(botPiece)
    drawHUD()

    if state == STATE_GAMEOVER then
        drawGameOver()
    end
end

function touched(t)
    if t.state == BEGAN then
        if state == STATE_START then
            if pointInButton(ui.startBtn, t.x, t.y) then
                state = STATE_MATCH
                return
            end

        elseif state == STATE_MATCH then
            if pointInButton(ui.backBtn, t.x, t.y) then
                state = STATE_START
                return
            end

            if pointInButton(ui.blackBtn, t.x, t.y) then
                chooseSides("black")
                return
            end

            if pointInButton(ui.whiteBtn, t.x, t.y) then
                chooseSides("white")
                return
            end

            if pointInButton(ui.fakeBotBtn, t.x, t.y) then
                resetGame()
                return
            end

        elseif state == STATE_PLAYING then
            if pointInButton(ui.leftBtn, t.x, t.y) then
                movePiece(playerPiece, -1)
                return
            end

            if pointInButton(ui.rightBtn, t.x, t.y) then
                movePiece(playerPiece, 1)
                return
            end

            if pointInButton(ui.rotBtn, t.x, t.y) then
                rotatePiece(playerPiece)
                return
            end

            if pointInButton(ui.downBtn, t.x, t.y) then
                playerFast = true
                return
            end

            if pointInButton(ui.hardDropBtn, t.x, t.y) then
                hardDropPiece(playerPiece)
                return
            end

        elseif state == STATE_GAMEOVER then
            if pointInButton(ui.restartBtn, t.x, t.y) then
                state = STATE_START
                return
            end
        end

    elseif t.state == ENDED or t.state == CANCELLED then
        playerFast = false
    end
end

function keyboard(key)
    if state ~= STATE_PLAYING then
        return
    end

    if key == LEFT then movePiece(playerPiece, -1) end
    if key == RIGHT then movePiece(playerPiece, 1) end
    if key == UP or key == "z" then rotatePiece(playerPiece) end
    if key == DOWN then playerFast = true end
    if key == RETURN or key == " " then hardDropPiece(playerPiece) end
end