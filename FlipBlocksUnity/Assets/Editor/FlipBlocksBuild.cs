using UnityEditor;

public static class FlipBlocksBuild
{
    public static void BuildMac()
    {
        BuildPipeline.BuildPlayer(
            new[] { "Assets/Scenes/Main.unity" },
            "../FlipBlocksUnityBuild/Flip Blocks.app",
            BuildTarget.StandaloneOSX,
            BuildOptions.None);
    }
}
