// Shiro one-click launcher.
//
// Sits at the repo root as Shiro.exe. Double-clicking it runs
// scripts\Start-Shiro.ps1 hidden, which brings up the ChatGPT relay, the
// DSH backend, the dedicated minimized ChatGPT browser profile and finally
// the Pake desktop shell (desktop\dist\Shiro.exe). The script is idempotent,
// so clicking the launcher while Shiro already runs just reopens the app.
//
// The script's output goes to a log FILE via PowerShell redirection, never
// through redirected pipes: the background services the script spawns
// inherit their parent's stdio handles, and an inherited pipe would keep
// Process.WaitForExit() blocked for as long as any service lives (which is
// exactly the hang the first version of this launcher had).
//
// Build with scripts\Build-Launcher.ps1 (uses the .NET Framework csc.exe
// that ships with Windows; no SDK install required).

using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

internal static class ShiroLauncher
{
    private static int Main()
    {
        string root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
        string script = Path.Combine(root, "scripts", "Start-Shiro.ps1");
        if (!File.Exists(script))
        {
            MessageBox.Show(
                "Start-Shiro.ps1 was not found next to the launcher:\n" + script +
                "\n\nKeep Shiro.exe in the root of the Shiro repository.",
                "Shiro", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 2;
        }

        string logDir;
        try
        {
            logDir = Path.Combine(Directory.GetParent(root).FullName, ".ShiroRuntime", "logs");
            Directory.CreateDirectory(logDir);
        }
        catch
        {
            logDir = Path.GetTempPath();
        }
        string log = Path.Combine(logDir, "launcher.log");

        var psi = new ProcessStartInfo
        {
            FileName = "PowerShell.exe",
            Arguments = "-NoProfile -ExecutionPolicy Bypass -Command \"try { & '" + script + "' *> '" + log + "' } catch { $_ | Out-File -Append '" + log + "'; exit 1 }; exit 0\"",
            WindowStyle = ProcessWindowStyle.Hidden,
            CreateNoWindow = true,
            UseShellExecute = false,
            WorkingDirectory = root,
        };

        int exitCode;
        using (var process = Process.Start(psi))
        {
            process.WaitForExit();
            exitCode = process.ExitCode;
        }

        if (exitCode != 0)
        {
            string tail = "";
            try
            {
                string[] lines = File.ReadAllLines(log);
                int start = Math.Max(0, lines.Length - 12);
                tail = string.Join("\n", lines, start, lines.Length - start);
            }
            catch
            {
            }
            MessageBox.Show(
                "Shiro failed to start (exit code " + exitCode + ").\n\n" + tail +
                "\n\nFull log: " + log,
                "Shiro", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        return exitCode;
    }
}
