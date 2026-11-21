namespace LibreTV.Switch;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        if (args.Length > 0)
        {
            RunCommand(args[0]);
            return;
        }

        ApplicationConfiguration.Initialize();
        Application.Run(new MainForm());
    }

    [System.Runtime.InteropServices.DllImport("kernel32.dll")]
    private static extern bool AttachConsole(int processId);

    private static void RunCommand(string command)
    {
        AttachConsole(-1);
        var server = new ServerController();
        switch (command)
        {
            case "--status":
                Console.WriteLine(server.IsRunning() ? "running" : "stopped");
                break;
            case "--start":
                server.StartAsync().GetAwaiter().GetResult();
                Console.WriteLine("running");
                break;
            case "--stop":
                server.Stop();
                Console.WriteLine("stopped");
                break;
            default:
                Console.Error.WriteLine("未知命令。可用：--status --start --stop");
                Environment.ExitCode = 2;
                break;
        }
    }
}
