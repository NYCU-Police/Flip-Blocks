using UnityEditor;

public static class BuildFlipBlocks
{
    public static void BuildMac()
    {
        var options = new BuildPlayerOptions
        {
            scenes = new[] { "Assets/Scenes/Main.unity" },
            locationPathName = "../FlipBlocksUnityBuild/FlipBlocks.app",
            target = BuildTarget.StandaloneOSX,
            options = BuildOptions.None
        };

        var report = BuildPipeline.BuildPlayer(options);
        if (report.summary.result != UnityEditor.Build.Reporting.BuildResult.Succeeded)
        {
            throw new System.Exception("Build failed: " + report.summary.result);
        }
    }
}
