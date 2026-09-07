using System;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.UI;

public sealed class FlipBlocksGame : MonoBehaviour
{
    private const int Cols = 10;
    private const int Rows = 20;
    private const int Player = 1;
    private const int Bot = 2;

    private enum GameState { Start, Match, Playing, GameOver }

    private struct Side
    {
        public string ColorName;
        public int ColorValue;
        public int Direction;
        public int SpawnY;
    }

    private sealed class Piece
    {
        public int Owner;
        public string Shape = "I";
        public int Rotation;
        public int X;
        public int Y;
        public int Direction;
        public int ColorValue;
    }

    private static readonly string[] ShapeKeys = { "I", "O", "T", "S", "Z", "J", "L" };
    private static readonly Dictionary<string, Vector2Int[][]> Shapes = new Dictionary<string, Vector2Int[][]>
    {
        ["I"] = new[]
        {
            Cells((0, 1), (1, 1), (2, 1), (3, 1)),
            Cells((2, 0), (2, 1), (2, 2), (2, 3)),
            Cells((0, 2), (1, 2), (2, 2), (3, 2)),
            Cells((1, 0), (1, 1), (1, 2), (1, 3))
        },
        ["O"] = new[]
        {
            Cells((1, 0), (2, 0), (1, 1), (2, 1)),
            Cells((1, 0), (2, 0), (1, 1), (2, 1)),
            Cells((1, 0), (2, 0), (1, 1), (2, 1)),
            Cells((1, 0), (2, 0), (1, 1), (2, 1))
        },
        ["T"] = new[]
        {
            Cells((1, 0), (0, 1), (1, 1), (2, 1)),
            Cells((1, 0), (1, 1), (2, 1), (1, 2)),
            Cells((0, 1), (1, 1), (2, 1), (1, 2)),
            Cells((1, 0), (0, 1), (1, 1), (1, 2))
        },
        ["S"] = new[]
        {
            Cells((1, 0), (2, 0), (0, 1), (1, 1)),
            Cells((1, 0), (1, 1), (2, 1), (2, 2)),
            Cells((1, 1), (2, 1), (0, 2), (1, 2)),
            Cells((0, 0), (0, 1), (1, 1), (1, 2))
        },
        ["Z"] = new[]
        {
            Cells((0, 0), (1, 0), (1, 1), (2, 1)),
            Cells((2, 0), (1, 1), (2, 1), (1, 2)),
            Cells((0, 1), (1, 1), (1, 2), (2, 2)),
            Cells((1, 0), (0, 1), (1, 1), (0, 2))
        },
        ["J"] = new[]
        {
            Cells((0, 0), (0, 1), (1, 1), (2, 1)),
            Cells((1, 0), (2, 0), (1, 1), (1, 2)),
            Cells((0, 1), (1, 1), (2, 1), (2, 2)),
            Cells((1, 0), (1, 1), (0, 2), (1, 2))
        },
        ["L"] = new[]
        {
            Cells((2, 0), (0, 1), (1, 1), (2, 1)),
            Cells((1, 0), (1, 1), (1, 2), (2, 2)),
            Cells((0, 1), (1, 1), (2, 1), (0, 2)),
            Cells((0, 0), (1, 0), (1, 1), (1, 2))
        }
    };

    private readonly int[,] board = new int[Cols + 1, Rows + 1];
    private readonly Queue<string> playerQueue = new Queue<string>();
    private readonly Queue<string> botQueue = new Queue<string>();
    private readonly System.Random random = new System.Random();

    private GameState state = GameState.Start;
    private Side playerSide;
    private Side botSide;
    private Piece playerPiece;
    private Piece botPiece;
    private bool playerFast;
    private bool botFast;
    private float playerDropTimer;
    private float botDropTimer;
    private string selectedColor = "black";
    private string winnerText = "";

    private const float BaseDrop = 0.45f;
    private const float SoftDrop = 0.08f;

    private Canvas canvas;
    private Font uiFont;
    private Material uiMaterial;
    private RectTransform root;
    private RectTransform boardRoot;
    private Image[,] boardImages;
    private Text blackScoreText;
    private Text whiteScoreText;
    private Image blackScoreFill;
    private Image whiteScoreFill;
    private Text playerInfoText;
    private Text botInfoText;
    private Text nextOneText;
    private Text nextTwoText;

    [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
    private static void Bootstrap()
    {
        if (FindAnyObjectByType<FlipBlocksGame>() != null)
        {
            return;
        }

        new GameObject("Flip Blocks Game").AddComponent<FlipBlocksGame>();
    }

    private static Vector2Int[] Cells(params (int x, int y)[] cells)
    {
        var result = new Vector2Int[cells.Length];
        for (var i = 0; i < cells.Length; i++)
        {
            result[i] = new Vector2Int(cells[i].x, cells[i].y);
        }
        return result;
    }

    private void Awake()
    {
        uiFont = Resources.GetBuiltinResource<Font>("Arial.ttf");
        var uiShader = Resources.Load<Shader>("FlipBlocksUI");
        if (uiShader == null)
        {
            uiShader = Shader.Find("UI/Default");
        }
        uiMaterial = uiShader == null ? null : new Material(uiShader);
        ChooseSides("black");
        BuildBaseScene();
        ShowStart();
    }

    private void Update()
    {
        HandleGlobalShortcuts();

        if (state != GameState.Playing)
        {
            return;
        }

        HandleKeyboard();
        AdvanceTimers(Time.deltaTime);
        RefreshBoard();
    }

    private void HandleGlobalShortcuts()
    {
        if (Input.GetKeyDown(KeyCode.Escape))
        {
            Application.Quit();
            return;
        }

        if (state == GameState.Start)
        {
            if (Input.GetKeyDown(KeyCode.Space) || Input.GetKeyDown(KeyCode.Return) || Input.GetMouseButtonDown(0))
            {
                ShowMatch();
            }
            return;
        }

        if (state == GameState.Match)
        {
            if (Input.GetKeyDown(KeyCode.B))
            {
                ChooseSides("black");
                ShowMatch();
                return;
            }

            if (Input.GetKeyDown(KeyCode.W))
            {
                ChooseSides("white");
                ShowMatch();
                return;
            }

            if (Input.GetKeyDown(KeyCode.Space) || Input.GetKeyDown(KeyCode.Return) || Input.GetMouseButtonDown(0))
            {
                ResetGame();
            }
            return;
        }

        if (state == GameState.GameOver)
        {
            if (Input.GetKeyDown(KeyCode.Space) || Input.GetKeyDown(KeyCode.Return) || Input.GetMouseButtonDown(0))
            {
                ShowStart();
            }
        }
    }

    private void BuildBaseScene()
    {
        Camera.main?.gameObject.SetActive(false);

        var cameraObject = new GameObject("UI Camera");
        var camera = cameraObject.AddComponent<Camera>();
        camera.clearFlags = CameraClearFlags.SolidColor;
        camera.backgroundColor = new Color(0.98f, 0.98f, 0.99f);
        camera.orthographic = true;

        var canvasObject = new GameObject("Canvas", typeof(RectTransform));
        canvas = canvasObject.AddComponent<Canvas>();
        canvas.renderMode = RenderMode.ScreenSpaceOverlay;
        var scaler = canvasObject.AddComponent<CanvasScaler>();
        scaler.uiScaleMode = CanvasScaler.ScaleMode.ScaleWithScreenSize;
        scaler.referenceResolution = new Vector2(1080, 1920);
        scaler.screenMatchMode = CanvasScaler.ScreenMatchMode.MatchWidthOrHeight;
        scaler.matchWidthOrHeight = 1f;
        canvasObject.AddComponent<GraphicRaycaster>();
        root = canvasObject.GetComponent<RectTransform>();

        if (FindAnyObjectByType<EventSystem>() == null)
        {
            var eventSystem = new GameObject("EventSystem");
            eventSystem.AddComponent<EventSystem>();
            eventSystem.AddComponent<StandaloneInputModule>();
        }
    }

    private void ClearScreen()
    {
        for (var i = root.childCount - 1; i >= 0; i--)
        {
            Destroy(root.GetChild(i).gameObject);
        }

        boardImages = null;
        boardRoot = null;
        blackScoreText = null;
        whiteScoreText = null;
        blackScoreFill = null;
        whiteScoreFill = null;
        playerInfoText = null;
        botInfoText = null;
        nextOneText = null;
        nextTwoText = null;
    }

    private void ShowStart()
    {
        state = GameState.Start;
        ClearScreen();
        AddText("翻轉方塊", new Vector2(0, 500), 66, Color.black, TextAnchor.MiddleCenter);
        AddText("Flip Blocks / 블록 뒤집기", new Vector2(0, 425), 34, new Color(0.2f, 0.2f, 0.22f), TextAnchor.MiddleCenter);
        AddText("區域占領、方塊推進、包圍翻轉", new Vector2(0, 300), 30, new Color(0.35f, 0.35f, 0.38f), TextAnchor.MiddleCenter);
        AddButton("開始遊戲", new Vector2(0, 120), new Vector2(430, 110), new Color(0.08f, 0.08f, 0.1f), Color.white, ShowMatch);
    }

    private void ShowMatch()
    {
        state = GameState.Match;
        ClearScreen();
        AddText("區域網路配對", new Vector2(0, 540), 58, Color.black, TextAnchor.MiddleCenter);
        AddText("本機雙人：P1 方向鍵 + Enter，P2 WASD + Space", new Vector2(0, 450), 28, new Color(0.35f, 0.35f, 0.38f), TextAnchor.MiddleCenter);
        AddText("目前選擇：" + (selectedColor == "black" ? "黑色" : "白色"), new Vector2(0, 260), 32, Color.black, TextAnchor.MiddleCenter);

        AddButton("選黑色", new Vector2(-210, 120), new Vector2(300, 96), selectedColor == "black" ? Color.black : new Color(0.3f, 0.3f, 0.34f), Color.white, () =>
        {
            ChooseSides("black");
            ShowMatch();
        });
        AddButton("選白色", new Vector2(210, 120), new Vector2(300, 96), Color.white, Color.black, () =>
        {
            ChooseSides("white");
            ShowMatch();
        });
        AddButton("開始雙人對戰", new Vector2(0, -70), new Vector2(520, 110), new Color(0.18f, 0.58f, 0.42f), Color.white, ResetGame);
        AddButton("返回", new Vector2(-330, -430), new Vector2(240, 86), new Color(0.86f, 0.86f, 0.88f), Color.black, ShowStart);

        AddText("P1：" + (selectedColor == "black" ? "黑色" : "白色") + "，方向鍵移動/旋轉，Enter 硬降", new Vector2(0, -280), 25, new Color(0.35f, 0.35f, 0.38f), TextAnchor.MiddleCenter);
        AddText("P2：" + (selectedColor == "black" ? "白色" : "黑色") + "，A/D 移動，W 旋轉，S 軟降，Space 硬降", new Vector2(0, -330), 25, new Color(0.35f, 0.35f, 0.38f), TextAnchor.MiddleCenter);
    }

    private void ShowGame()
    {
        ClearScreen();
        BuildScoreBar();
        BuildBoard();
        BuildHud();
        RefreshBoard();
    }

    private void BuildScoreBar()
    {
        var frame = AddPanel(new Vector2(0, 780), new Vector2(860, 44), new Color(0.92f, 0.92f, 0.94f));
        blackScoreFill = AddPanel(new Vector2(-215, 780), new Vector2(430, 34), Color.black, frame.transform);
        whiteScoreFill = AddPanel(new Vector2(215, 780), new Vector2(430, 34), Color.white, frame.transform);
        blackScoreText = AddText("Black 50%", new Vector2(-335, 835), 24, Color.black, TextAnchor.MiddleLeft);
        whiteScoreText = AddText("White 50%", new Vector2(335, 835), 24, Color.black, TextAnchor.MiddleRight);
        AddPanel(new Vector2(172, 780), new Vector2(4, 60), new Color(1f, 0.25f, 0.25f));
    }

    private void BuildBoard()
    {
        boardRoot = AddPanel(new Vector2(0, 80), new Vector2(560, 1040), new Color(0.94f, 0.94f, 0.96f)).GetComponent<RectTransform>();
        boardImages = new Image[Cols + 1, Rows + 1];
        var cell = 50f;
        var startX = -(Cols * cell) / 2f + cell / 2f;
        var startY = -(Rows * cell) / 2f + cell / 2f;

        for (var y = 1; y <= Rows; y++)
        {
            for (var x = 1; x <= Cols; x++)
            {
                boardImages[x, y] = AddPanel(
                    new Vector2(startX + (x - 1) * cell, startY + (y - 1) * cell),
                    new Vector2(cell - 2f, cell - 2f),
                    CellColor(board[x, y]),
                    boardRoot).GetComponent<Image>();
            }
        }

        AddPanel(new Vector2(0, 0), new Vector2(520, 4), new Color(1f, 0.2f, 0.2f, 0.8f), boardRoot);
    }

    private void BuildHud()
    {
        nextOneText = AddText("", new Vector2(-330, -560), 30, Color.black, TextAnchor.MiddleCenter);
        nextTwoText = AddText("", new Vector2(330, -560), 30, Color.black, TextAnchor.MiddleCenter);
        playerInfoText = AddText("", new Vector2(-320, -640), 24, Color.black, TextAnchor.MiddleCenter);
        botInfoText = AddText("", new Vector2(320, -640), 24, Color.black, TextAnchor.MiddleCenter);

        AddButton("←", new Vector2(-360, -800), new Vector2(145, 125), new Color(0.1f, 0.1f, 0.12f), Color.white, () => MovePiece(playerPiece, -1));
        AddButton("→", new Vector2(-180, -800), new Vector2(145, 125), new Color(0.1f, 0.1f, 0.12f), Color.white, () => MovePiece(playerPiece, 1));
        AddButton("⟳", new Vector2(0, -800), new Vector2(145, 125), new Color(0.88f, 0.88f, 0.9f), Color.black, () => RotatePiece(playerPiece));
        AddHoldButton("↓", new Vector2(180, -800), new Vector2(145, 125), new Color(0.72f, 0.88f, 0.84f), Color.black, () => playerFast = true, () => playerFast = false);
        AddButton("⇣", new Vector2(360, -800), new Vector2(145, 125), new Color(1f, 0.83f, 0.52f), Color.black, () => HardDropPiece(playerPiece));
    }

    private void ResetGame()
    {
        InitBoard();
        playerQueue.Clear();
        botQueue.Clear();
        FillQueue(playerQueue);
        FillQueue(botQueue);
        playerPiece = null;
        botPiece = null;
        playerDropTimer = 0f;
        botDropTimer = 0f;
        playerFast = false;
        botFast = false;
        winnerText = "";
        state = GameState.Playing;
        SpawnPiece(Player);
        SpawnPiece(Bot);
        ShowGame();
    }

    private void ChooseSides(string choice)
    {
        selectedColor = choice;
        if (choice == "black")
        {
            playerSide = new Side { ColorName = "black", ColorValue = 1, Direction = -1, SpawnY = Rows + 1 };
            botSide = new Side { ColorName = "white", ColorValue = 2, Direction = 1, SpawnY = -3 };
        }
        else
        {
            playerSide = new Side { ColorName = "white", ColorValue = 2, Direction = 1, SpawnY = -3 };
            botSide = new Side { ColorName = "black", ColorValue = 1, Direction = -1, SpawnY = Rows + 1 };
        }
    }

    private void InitBoard()
    {
        for (var y = 1; y <= Rows; y++)
        {
            for (var x = 1; x <= Cols; x++)
            {
                board[x, y] = y <= Rows / 2 ? playerSide.ColorValue : botSide.ColorValue;
            }
        }
    }

    private void FillQueue(Queue<string> queue)
    {
        while (queue.Count < 3)
        {
            queue.Enqueue(ShapeKeys[random.Next(ShapeKeys.Length)]);
        }
    }

    private Piece MakePiece(int owner, string shape)
    {
        var side = owner == Player ? playerSide : botSide;
        return new Piece
        {
            Owner = owner,
            Shape = shape,
            Rotation = 0,
            X = 4,
            Y = side.SpawnY,
            Direction = side.Direction,
            ColorValue = side.ColorValue
        };
    }

    private void SpawnPiece(int owner)
    {
        if (state != GameState.Playing)
        {
            return;
        }

        var queue = owner == Player ? playerQueue : botQueue;
        FillQueue(queue);
        var shape = queue.Dequeue();
        FillQueue(queue);

        if (owner == Player)
        {
            playerPiece = MakePiece(owner, shape);
        }
        else
        {
            botPiece = MakePiece(owner, shape);
        }
    }

    private void AdvanceTimers(float dt)
    {
        playerDropTimer += dt;
        if (playerDropTimer >= (playerFast ? SoftDrop : BaseDrop))
        {
            playerDropTimer = 0f;
            StepPiece(playerPiece);
        }

        botDropTimer += dt;
        if (botDropTimer >= (botFast ? SoftDrop : BaseDrop))
        {
            botDropTimer = 0f;
            StepPiece(botPiece);
        }
    }

    private void HandleKeyboard()
    {
        if (Input.GetKeyDown(KeyCode.LeftArrow))
        {
            MovePiece(playerPiece, -1);
        }
        if (Input.GetKeyDown(KeyCode.RightArrow))
        {
            MovePiece(playerPiece, 1);
        }
        if (Input.GetKeyDown(KeyCode.UpArrow))
        {
            RotatePiece(playerPiece);
        }
        if (Input.GetKey(KeyCode.DownArrow))
        {
            playerFast = true;
        }
        if (Input.GetKeyUp(KeyCode.DownArrow))
        {
            playerFast = false;
        }
        if (Input.GetKeyDown(KeyCode.Return))
        {
            HardDropPiece(playerPiece);
        }

        if (Input.GetKeyDown(KeyCode.A))
        {
            MovePiece(botPiece, -1);
        }
        if (Input.GetKeyDown(KeyCode.D))
        {
            MovePiece(botPiece, 1);
        }
        if (Input.GetKeyDown(KeyCode.W))
        {
            RotatePiece(botPiece);
        }
        if (Input.GetKey(KeyCode.S))
        {
            botFast = true;
        }
        if (Input.GetKeyUp(KeyCode.S))
        {
            botFast = false;
        }
        if (Input.GetKeyDown(KeyCode.Space))
        {
            HardDropPiece(botPiece);
        }
    }

    private void StepPiece(Piece piece)
    {
        if (piece == null || state != GameState.Playing)
        {
            return;
        }

        if (CanAdvance(piece))
        {
            piece.Y += piece.Direction;
            return;
        }

        if (PieceHasAnyInBoardCell(piece, piece.X, piece.Y, piece.Rotation))
        {
            LockPiece(piece);
        }

        if (state != GameState.Playing)
        {
            return;
        }

        SpawnPiece(piece.Owner);
    }

    private void HardDropPiece(Piece piece)
    {
        if (piece == null || state != GameState.Playing)
        {
            return;
        }

        while (CanAdvance(piece))
        {
            piece.Y += piece.Direction;
        }

        if (PieceHasAnyInBoardCell(piece, piece.X, piece.Y, piece.Rotation))
        {
            LockPiece(piece);
        }

        if (state == GameState.Playing)
        {
            SpawnPiece(piece.Owner);
        }
    }

    private bool CanAdvance(Piece piece)
    {
        var nextY = piece.Y + piece.Direction;
        return CanStayAt(piece, piece.X, nextY, piece.Rotation) && !PieceTouchesOwnColor(piece, nextY);
    }

    private void MovePiece(Piece piece, int dx)
    {
        if (piece == null || state != GameState.Playing)
        {
            return;
        }

        var nextX = piece.X + dx;
        if (CanStayAt(piece, nextX, piece.Y, piece.Rotation))
        {
            piece.X = nextX;
        }
    }

    private void RotatePiece(Piece piece)
    {
        if (piece == null || state != GameState.Playing)
        {
            return;
        }

        var nextRotation = (piece.Rotation + 1) % 4;
        var kicks = new[] { 0, -1, 1, -2, 2 };
        foreach (var kick in kicks)
        {
            var nextX = piece.X + kick;
            if (CanStayAt(piece, nextX, piece.Y, nextRotation))
            {
                piece.X = nextX;
                piece.Rotation = nextRotation;
                return;
            }
        }
    }

    private bool CanStayAt(Piece piece, int testX, int testY, int testRotation)
    {
        foreach (var cell in PieceCells(piece, testX, testY, testRotation))
        {
            if (cell.x < 1 || cell.x > Cols)
            {
                return false;
            }
        }
        return true;
    }

    private bool PieceTouchesOwnColor(Piece piece, int testY)
    {
        foreach (var cell in PieceCells(piece, piece.X, testY, piece.Rotation))
        {
            if (InBounds(cell.x, cell.y) && board[cell.x, cell.y] == piece.ColorValue)
            {
                return true;
            }
        }
        return false;
    }

    private bool PieceHasAnyInBoardCell(Piece piece, int testX, int testY, int testRotation)
    {
        foreach (var cell in PieceCells(piece, testX, testY, testRotation))
        {
            if (InBounds(cell.x, cell.y))
            {
                return true;
            }
        }
        return false;
    }

    private IEnumerable<Vector2Int> PieceCells(Piece piece, int x, int y, int rotation)
    {
        foreach (var offset in Shapes[piece.Shape][rotation])
        {
            yield return new Vector2Int(x + offset.x, y + offset.y);
        }
    }

    private void LockPiece(Piece piece)
    {
        foreach (var cell in PieceCells(piece, piece.X, piece.Y, piece.Rotation))
        {
            if (InBounds(cell.x, cell.y))
            {
                board[cell.x, cell.y] = piece.ColorValue;
            }
        }

        ResolveCaptures(piece.ColorValue);
        CheckEndState();
    }

    private void ResolveCaptures(int attackerColor)
    {
        var defenderColor = OtherColor(attackerColor);
        while (true)
        {
            var deadGroups = CollectDeadGroups(defenderColor);
            var flipped = 0;
            foreach (var group in deadGroups)
            {
                foreach (var cell in group)
                {
                    if (board[cell.x, cell.y] != attackerColor)
                    {
                        board[cell.x, cell.y] = attackerColor;
                        flipped++;
                    }
                }
            }

            if (flipped == 0)
            {
                break;
            }
        }
    }

    private List<List<Vector2Int>> CollectDeadGroups(int colorValue)
    {
        var visited = new bool[Cols + 1, Rows + 1];
        var deadGroups = new List<List<Vector2Int>>();
        for (var y = 1; y <= Rows; y++)
        {
            for (var x = 1; x <= Cols; x++)
            {
                if (board[x, y] != colorValue || visited[x, y])
                {
                    continue;
                }

                var group = CollectGroup(x, y, colorValue, visited, out var touchesHome);
                if (!touchesHome)
                {
                    deadGroups.Add(group);
                }
            }
        }
        return deadGroups;
    }

    private List<Vector2Int> CollectGroup(int startX, int startY, int colorValue, bool[,] visited, out bool touchesHome)
    {
        var group = new List<Vector2Int>();
        var queue = new Queue<Vector2Int>();
        var homeRow = HomeRowForColor(colorValue);
        touchesHome = false;

        visited[startX, startY] = true;
        queue.Enqueue(new Vector2Int(startX, startY));

        while (queue.Count > 0)
        {
            var current = queue.Dequeue();
            group.Add(current);
            if (current.y == homeRow)
            {
                touchesHome = true;
            }

            TryVisit(current.x + 1, current.y);
            TryVisit(current.x - 1, current.y);
            TryVisit(current.x, current.y + 1);
            TryVisit(current.x, current.y - 1);
        }

        return group;

        void TryVisit(int x, int y)
        {
            if (!InBounds(x, y) || visited[x, y] || board[x, y] != colorValue)
            {
                return;
            }

            visited[x, y] = true;
            queue.Enqueue(new Vector2Int(x, y));
        }
    }

    private void CheckEndState()
    {
        CountBoard(out var black, out var white);
        var total = Cols * Rows;
        if (black / (float)total >= 0.7f)
        {
            EndGame(WinnerTextForColor(1));
            return;
        }
        if (white / (float)total >= 0.7f)
        {
            EndGame(WinnerTextForColor(2));
            return;
        }
        if (CountRowsOfColor(1) == Rows)
        {
            EndGame(WinnerTextForColor(1));
            return;
        }
        if (CountRowsOfColor(2) == Rows)
        {
            EndGame(WinnerTextForColor(2));
        }
    }

    private string WinnerTextForColor(int colorValue)
    {
        return playerSide.ColorValue == colorValue ? "P1 獲勝" : "P2 獲勝";
    }

    private void EndGame(string text)
    {
        winnerText = text;
        state = GameState.GameOver;
        RefreshBoard();
        var overlay = AddPanel(Vector2.zero, new Vector2(1080, 1920), new Color(0f, 0f, 0f, 0.62f));
        overlay.transform.SetAsLastSibling();
        AddText(winnerText, new Vector2(0, 120), 62, Color.white, TextAnchor.MiddleCenter);
        AddText("點再玩一次回到開始畫面", new Vector2(0, 35), 30, Color.white, TextAnchor.MiddleCenter);
        AddButton("再玩一次", new Vector2(0, -120), new Vector2(360, 110), Color.white, Color.black, ShowStart);
    }

    private int CountRowsOfColor(int colorValue)
    {
        var rowsOwned = 0;
        for (var y = 1; y <= Rows; y++)
        {
            var full = true;
            for (var x = 1; x <= Cols; x++)
            {
                if (board[x, y] != colorValue)
                {
                    full = false;
                    break;
                }
            }
            if (full)
            {
                rowsOwned++;
            }
        }
        return rowsOwned;
    }

    private void RefreshBoard()
    {
        if (boardImages == null)
        {
            return;
        }

        for (var y = 1; y <= Rows; y++)
        {
            for (var x = 1; x <= Cols; x++)
            {
                boardImages[x, y].color = CellColor(board[x, y]);
            }
        }

        DrawPiece(playerPiece);
        DrawPiece(botPiece);
        RefreshHud();
    }

    private void DrawPiece(Piece piece)
    {
        if (piece == null)
        {
            return;
        }

        foreach (var cell in PieceCells(piece, piece.X, piece.Y, piece.Rotation))
        {
            if (InBounds(cell.x, cell.y))
            {
                var color = CellColor(piece.ColorValue);
                color.a = 0.72f;
                boardImages[cell.x, cell.y].color = color;
            }
        }
    }

    private void RefreshHud()
    {
        CountBoard(out var black, out var white);
        var total = Cols * Rows;
        var blackPct = black / (float)total;
        var whitePct = white / (float)total;

        blackScoreFill.rectTransform.sizeDelta = new Vector2(860f * blackPct, 34f);
        whiteScoreFill.rectTransform.sizeDelta = new Vector2(860f * whitePct, 34f);
        blackScoreFill.rectTransform.anchoredPosition = new Vector2(-430f + blackScoreFill.rectTransform.sizeDelta.x / 2f, 0f);
        whiteScoreFill.rectTransform.anchoredPosition = new Vector2(430f - whiteScoreFill.rectTransform.sizeDelta.x / 2f, 0f);
        blackScoreText.text = $"Black {blackPct:P0}";
        whiteScoreText.text = $"White {whitePct:P0}";
        nextOneText.text = "P1 Next: " + PeekQueue(playerQueue, 0);
        nextTwoText.text = "P2 Next: " + PeekQueue(botQueue, 0);

        var playerArrow = playerSide.Direction == -1 ? "↓" : "↑";
        var botArrow = botSide.Direction == -1 ? "↓" : "↑";
        playerInfoText.text = $"P1: {(playerSide.ColorName == "black" ? "黑色" : "白色")} {playerArrow} 方向鍵 + Enter";
        botInfoText.text = $"P2: {(botSide.ColorName == "black" ? "黑色" : "白色")} {botArrow} WASD + Space";
    }

    private static string PeekQueue(Queue<string> queue, int index)
    {
        var i = 0;
        foreach (var item in queue)
        {
            if (i == index)
            {
                return item;
            }
            i++;
        }
        return "-";
    }

    private void CountBoard(out int black, out int white)
    {
        black = 0;
        white = 0;
        for (var y = 1; y <= Rows; y++)
        {
            for (var x = 1; x <= Cols; x++)
            {
                if (board[x, y] == 1)
                {
                    black++;
                }
                else if (board[x, y] == 2)
                {
                    white++;
                }
            }
        }
    }

    private int HomeRowForColor(int colorValue)
    {
        var side = playerSide.ColorValue == colorValue ? playerSide : botSide;
        return side.Direction == -1 ? 1 : Rows;
    }

    private static int OtherColor(int colorValue) => colorValue == 1 ? 2 : 1;

    private static bool InBounds(int x, int y) => x >= 1 && x <= Cols && y >= 1 && y <= Rows;

    private static Color CellColor(int value)
    {
        return value == 1 ? new Color(0.07f, 0.07f, 0.09f) : new Color(0.98f, 0.98f, 0.99f);
    }

    private Image AddPanel(Vector2 anchoredPosition, Vector2 size, Color color, Transform parent = null)
    {
        var go = new GameObject("Panel", typeof(RectTransform));
        go.transform.SetParent(parent == null ? root : parent, false);
        var rect = go.GetComponent<RectTransform>();
        rect.anchorMin = new Vector2(0.5f, 0.5f);
        rect.anchorMax = new Vector2(0.5f, 0.5f);
        rect.anchoredPosition = anchoredPosition;
        rect.sizeDelta = size;
        var image = go.AddComponent<Image>();
        image.color = color;
        if (uiMaterial != null)
        {
            image.material = uiMaterial;
        }
        return image;
    }

    private Text AddText(string value, Vector2 anchoredPosition, int size, Color color, TextAnchor alignment, Transform parent = null)
    {
        var go = new GameObject("Text", typeof(RectTransform));
        go.transform.SetParent(parent == null ? root : parent, false);
        var rect = go.GetComponent<RectTransform>();
        rect.anchorMin = new Vector2(0.5f, 0.5f);
        rect.anchorMax = new Vector2(0.5f, 0.5f);
        rect.anchoredPosition = anchoredPosition;
        rect.sizeDelta = new Vector2(920, 90);
        var text = go.AddComponent<Text>();
        text.text = value;
        text.font = uiFont;
        text.fontSize = size;
        text.color = color;
        text.alignment = alignment;
        text.resizeTextForBestFit = true;
        text.resizeTextMinSize = 12;
        text.resizeTextMaxSize = size;
        if (uiMaterial != null)
        {
            text.material = uiMaterial;
        }
        return text;
    }

    private Button AddButton(string label, Vector2 anchoredPosition, Vector2 size, Color background, Color foreground, UnityEngine.Events.UnityAction action)
    {
        var image = AddPanel(anchoredPosition, size, background);
        image.gameObject.name = "Button " + label;
        var button = image.gameObject.AddComponent<Button>();
        button.targetGraphic = image;
        button.onClick.AddListener(action);

        var text = AddText(label, Vector2.zero, Mathf.RoundToInt(size.y * 0.35f), foreground, TextAnchor.MiddleCenter, image.transform);
        text.rectTransform.sizeDelta = size;
        text.raycastTarget = false;
        return button;
    }

    private void AddHoldButton(string label, Vector2 anchoredPosition, Vector2 size, Color background, Color foreground, Action onDown, Action onUp)
    {
        var button = AddButton(label, anchoredPosition, size, background, foreground, () => { });
        var trigger = button.gameObject.AddComponent<EventTrigger>();

        var down = new EventTrigger.Entry { eventID = EventTriggerType.PointerDown };
        down.callback.AddListener(_ => onDown());
        trigger.triggers.Add(down);

        var up = new EventTrigger.Entry { eventID = EventTriggerType.PointerUp };
        up.callback.AddListener(_ => onUp());
        trigger.triggers.Add(up);

        var exit = new EventTrigger.Entry { eventID = EventTriggerType.PointerExit };
        exit.callback.AddListener(_ => onUp());
        trigger.triggers.Add(exit);
    }
}
