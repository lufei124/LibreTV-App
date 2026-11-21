using System.Diagnostics;
using System.Net.Sockets;

namespace LibreTV.Switch;

internal sealed class ServerController
{
    public const int Port = 8899;
    public const string Host = "127.0.0.1";
    public static string Url => $"http://{Host}:{Port}";

    private Process? _process;

    public string AppRoot { get; }

    public ServerController()
    {
        AppRoot = FindAppRoot();
    }

    public bool IsRunning()
    {
        if (_process is { HasExited: false })
        {
            return true;
        }

        return IsPortOpen();
    }

    public async Task StartAsync(CancellationToken cancellationToken = default)
    {
        if (IsRunning())
        {
            return;
        }

        var node = FindNode();
        var script = Path.Combine(AppRoot, "serve-local.mjs");
        if (!File.Exists(script))
        {
            throw new InvalidOperationException($"找不到启动脚本：{script}");
        }

        var startInfo = new ProcessStartInfo(node, "serve-local.mjs")
        {
            WorkingDirectory = AppRoot,
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
        };
        startInfo.Environment["HOST"] = Host;
        startInfo.Environment["PORT"] = Port.ToString();

        _process = Process.Start(startInfo)
            ?? throw new InvalidOperationException("无法启动 Node 进程。");

        var deadline = DateTime.UtcNow.AddSeconds(12);
        while (DateTime.UtcNow < deadline)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (_process.HasExited)
            {
                throw new InvalidOperationException($"服务启动后立即退出，退出码 {_process.ExitCode}。");
            }

            if (IsPortOpen())
            {
                return;
            }

            await Task.Delay(250, cancellationToken);
        }

        throw new InvalidOperationException("服务已启动，但端口 8899 没有在预期时间内打开。");
    }

    public void Stop()
    {
        if (_process is { HasExited: false })
        {
            KillTree(_process.Id);
            _process = null;
            return;
        }

        _process = null;
        var pid = FindListenerPid(Port);
        if (pid is null)
        {
            return;
        }

        var commandLine = GetCommandLine(pid.Value) ?? "";
        if (!commandLine.Contains("serve-local.mjs", StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException($"端口 {Port} 被其他程序占用（PID {pid}），没有关闭它。");
        }

        KillTree(pid.Value);
    }

    public static void OpenBrowser()
    {
        Process.Start(new ProcessStartInfo(Url) { UseShellExecute = true });
    }

    private static bool IsPortOpen()
    {
        try
        {
            using var client = new TcpClient();
            var task = client.ConnectAsync(Host, Port);
            return task.Wait(TimeSpan.FromMilliseconds(400)) && client.Connected;
        }
        catch
        {
            return false;
        }
    }

    private static int? FindListenerPid(int port)
    {
        var startInfo = new ProcessStartInfo("netstat", "-ano -p TCP")
        {
            RedirectStandardOutput = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };

        using var process = Process.Start(startInfo);
        if (process is null)
        {
            return null;
        }

        var output = process.StandardOutput.ReadToEnd();
        process.WaitForExit(3000);
        var suffix = ":" + port;

        foreach (var raw in output.Split('\n'))
        {
            var line = raw.Trim();
            if (line.Length == 0 || !line.StartsWith("TCP", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            if (!line.Contains("LISTENING", StringComparison.OrdinalIgnoreCase)
                && !line.Contains("侦听", StringComparison.Ordinal))
            {
                continue;
            }

            var parts = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length < 5 || !parts[1].EndsWith(suffix, StringComparison.Ordinal))
            {
                continue;
            }

            if (int.TryParse(parts[^1], out var pid))
            {
                return pid;
            }
        }

        return null;
    }

    private static string? GetCommandLine(int pid)
    {
        var startInfo = new ProcessStartInfo(
            "powershell",
            $"-NoProfile -Command \"(Get-CimInstance Win32_Process -Filter 'ProcessId={pid}').CommandLine\"")
        {
            RedirectStandardOutput = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };

        using var process = Process.Start(startInfo);
        if (process is null)
        {
            return null;
        }

        var output = process.StandardOutput.ReadToEnd().Trim();
        process.WaitForExit(4000);
        return output.Length == 0 ? null : output;
    }

    private static void KillTree(int pid)
    {
        var startInfo = new ProcessStartInfo("taskkill", $"/PID {pid} /T /F")
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };

        using var process = Process.Start(startInfo);
        process?.WaitForExit(5000);
    }

    private static string FindNode()
    {
        var path = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (var dir in path.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            var candidate = Path.Combine(dir.Trim(), "node.exe");
            if (File.Exists(candidate))
            {
                return candidate;
            }
        }

        throw new InvalidOperationException("没有找到 node.exe，请先安装 Node.js。");
    }

    private static string FindAppRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            if (File.Exists(Path.Combine(dir.FullName, "serve-local.mjs")))
            {
                return dir.FullName;
            }

            dir = dir.Parent;
        }

        throw new InvalidOperationException("没有在程序附近找到 LibreTV 的 serve-local.mjs。");
    }
}
