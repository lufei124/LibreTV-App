namespace LibreTV.Switch;

internal sealed class MainForm : Form
{
    private static readonly Color Page = Color.FromArgb(15, 22, 34);
    private static readonly Color Card = Color.FromArgb(18, 27, 41);
    private static readonly Color Accent = Color.FromArgb(0, 204, 255);
    private static readonly Color Muted = Color.FromArgb(133, 153, 178);
    private static readonly Color Danger = Color.FromArgb(255, 107, 139);

    private readonly ServerController _server = new();
    private readonly ToggleSwitch _toggle = new();
    private readonly Label _status = new();
    private readonly Label _detail = new();
    private readonly Button _openButton = new();
    private readonly System.Windows.Forms.Timer _poll = new();
    private bool _busy;

    public MainForm()
    {
        Text = "LibreTV 开关";
        FormBorderStyle = FormBorderStyle.FixedSingle;
        MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(420, 280);
        BackColor = Page;
        ForeColor = Color.White;
        Font = new Font("Microsoft YaHei UI", 10F);

        var title = new Label
        {
            Text = "LibreTV",
            Font = new Font("Microsoft YaHei UI", 22F, FontStyle.Bold),
            ForeColor = Color.White,
            AutoSize = true,
            Location = new Point(36, 28),
        };

        var subtitle = new Label
        {
            Text = "本地服务",
            Font = new Font("Microsoft YaHei UI", 10F),
            ForeColor = Muted,
            AutoSize = true,
            Location = new Point(168, 42),
        };

        _toggle.Location = new Point(36, 96);
        _toggle.CheckedChanged += async (_, _) => await OnToggleAsync();

        _status.AutoSize = true;
        _status.Font = new Font("Microsoft YaHei UI", 16F, FontStyle.Bold);
        _status.Location = new Point(150, 100);

        _detail.AutoSize = false;
        _detail.Size = new Size(250, 44);
        _detail.ForeColor = Muted;
        _detail.Location = new Point(150, 136);

        _openButton.Text = "打开页面";
        _openButton.Size = new Size(348, 40);
        _openButton.Location = new Point(36, 210);
        _openButton.FlatStyle = FlatStyle.Flat;
        _openButton.FlatAppearance.BorderSize = 0;
        _openButton.BackColor = Accent;
        _openButton.ForeColor = Color.FromArgb(8, 16, 28);
        _openButton.Font = new Font("Microsoft YaHei UI", 11F, FontStyle.Bold);
        _openButton.Cursor = Cursors.Hand;
        _openButton.Click += (_, _) =>
        {
            try
            {
                ServerController.OpenBrowser();
            }
            catch (Exception ex)
            {
                ShowError(ex.Message);
            }
        };

        Controls.Add(title);
        Controls.Add(subtitle);
        Controls.Add(_toggle);
        Controls.Add(_status);
        Controls.Add(_detail);
        Controls.Add(_openButton);

        _poll.Interval = 2000;
        _poll.Tick += (_, _) =>
        {
            if (!_busy)
            {
                ApplyState(_server.IsRunning(), null);
            }
        };

        Load += (_, _) =>
        {
            ApplyState(_server.IsRunning(), null);
            _poll.Start();
        };
        FormClosed += (_, _) => _poll.Stop();
    }

    private async Task OnToggleAsync()
    {
        if (_busy)
        {
            return;
        }

        _busy = true;
        _toggle.Enabled = false;
        var turnOn = _toggle.Checked;
        ApplyState(turnOn, turnOn ? "正在启动…" : "正在关闭…");

        try
        {
            if (turnOn)
            {
                await _server.StartAsync();
                ApplyState(true, null);
            }
            else
            {
                await Task.Run(_server.Stop);
                ApplyState(false, null);
            }
        }
        catch (Exception ex)
        {
            ApplyState(_server.IsRunning(), null);
            ShowError(ex.Message);
        }
        finally
        {
            _busy = false;
            _toggle.Enabled = true;
        }
    }

    private void ApplyState(bool running, string? message)
    {
        if (_toggle.Checked != running)
        {
            _toggle.SetCheckedSilently(running);
        }

        _status.Text = running ? "已启动" : "已停止";
        _status.ForeColor = running ? Accent : Muted;
        _detail.Text = message ?? (running ? ServerController.Url : "打开开关后即可在浏览器里使用");
        _detail.ForeColor = message is null ? Muted : Accent;
        _openButton.Enabled = running && message is null;
        _openButton.BackColor = _openButton.Enabled ? Accent : Color.FromArgb(40, 52, 70);
        _openButton.ForeColor = _openButton.Enabled ? Color.FromArgb(8, 16, 28) : Muted;
    }

    private void ShowError(string message)
    {
        _detail.Text = message;
        _detail.ForeColor = Danger;
        MessageBox.Show(this, message, "LibreTV 开关", MessageBoxButtons.OK, MessageBoxIcon.Warning);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        using var pen = new Pen(Color.FromArgb(32, 48, 68));
        e.Graphics.DrawLine(pen, 36, 188, ClientSize.Width - 36, 188);
    }
}

internal sealed class ToggleSwitch : Control
{
    private static readonly Color OffTrack = Color.FromArgb(45, 58, 78);
    private static readonly Color OnTrack = Color.FromArgb(0, 204, 255);
    private bool _checked;

    public event EventHandler? CheckedChanged;

    [System.ComponentModel.Browsable(false)]
    [System.ComponentModel.DesignerSerializationVisibility(System.ComponentModel.DesignerSerializationVisibility.Hidden)]
    public bool Checked
    {
        get => _checked;
        set
        {
            if (_checked == value)
            {
                return;
            }

            _checked = value;
            Invalidate();
            CheckedChanged?.Invoke(this, EventArgs.Empty);
        }
    }

    public ToggleSwitch()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint | ControlStyles.ResizeRedraw, true);
        Size = new Size(92, 48);
        Cursor = Cursors.Hand;
    }

    public void SetCheckedSilently(bool value)
    {
        if (_checked == value)
        {
            return;
        }

        _checked = value;
        Invalidate();
    }

    protected override void OnClick(EventArgs e)
    {
        if (!Enabled)
        {
            return;
        }

        Checked = !Checked;
        base.OnClick(e);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        e.Graphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
        var track = new Rectangle(2, 8, Width - 4, Height - 16);
        using var path = Rounded(track, track.Height);
        using var brush = new SolidBrush(Enabled ? (_checked ? OnTrack : OffTrack) : Color.FromArgb(32, 40, 54));
        e.Graphics.FillPath(brush, path);

        var knobSize = track.Height - 8;
        var x = _checked ? track.Right - knobSize - 4 : track.Left + 4;
        var knob = new Rectangle(x, track.Top + 4, knobSize, knobSize);
        using var knobBrush = new SolidBrush(_checked ? Color.FromArgb(8, 20, 32) : Color.White);
        e.Graphics.FillEllipse(knobBrush, knob);
    }

    private static System.Drawing.Drawing2D.GraphicsPath Rounded(Rectangle bounds, int radius)
    {
        var path = new System.Drawing.Drawing2D.GraphicsPath();
        var d = radius;
        path.AddArc(bounds.Left, bounds.Top, d, d, 180, 90);
        path.AddArc(bounds.Right - d, bounds.Top, d, d, 270, 90);
        path.AddArc(bounds.Right - d, bounds.Bottom - d, d, d, 0, 90);
        path.AddArc(bounds.Left, bounds.Bottom - d, d, d, 90, 90);
        path.CloseFigure();
        return path;
    }
}
