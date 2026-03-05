const User = require("../models/User");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const nodemailer = require("nodemailer");

// Email transporter — flexible SMTP config
// Supports Gmail (default) or any provider via SMTP_HOST + SMTP_PORT env vars
// Gmail: set SMTP_USER + SMTP_PASS (App Password from https://myaccount.google.com/apppasswords)
// Other: also set SMTP_HOST and SMTP_PORT
const smtpConfig = process.env.SMTP_HOST
  ? {
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT) || 587,
      secure: parseInt(process.env.SMTP_PORT) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    }
  : {
      service: "gmail",
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    };

const transporter = nodemailer.createTransport(smtpConfig);

// Password strength regex: min 8 chars, 1 uppercase, 1 lowercase, 1 number, 1 symbol
const strongPasswordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]).{8,}$/;

// Register user
exports.registerUser = async (req, res) => {
  try {

    const { username, email, password } = req.body;

    if (!strongPasswordRegex.test(password)) {
      return res.status(400).json({
        message: "Password must be at least 8 characters with 1 uppercase, 1 lowercase, 1 number, and 1 symbol"
      });
    }

    const existingUsername = await User.findOne({ username });
    if (existingUsername) {
      return res.status(400).json({ message: "Username already taken" });
    }

    const existingEmail = await User.findOne({ email });
    if (existingEmail) {
      return res.status(400).json({ message: "Email already registered" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await User.create({
      username,
      email,
      password: hashedPassword
    });

    res.status(201).json(user);

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Login user
exports.loginUser = async (req, res) => {
  try {

    const { username, password } = req.body;

    const user = await User.findOne({ username });

    if (!user) {
      return res.status(400).json({ message: "Invalid credentials" });
    }

    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return res.status(400).json({ message: "Invalid credentials" });
    }

    const token = jwt.sign(
      { id: user._id },
      process.env.JWT_SECRET,
      { expiresIn: "1d" }
    );

    res.json({
      token,
      user: {
        _id: user._id,
        username: user.username,
        email: user.email,
        profilePic: user.profilePic || null
      }
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Forgot password — generate reset token
exports.forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ message: "No account found with that email" });
    }

    // Generate a 6-character alphanumeric reset code
    const resetToken = crypto.randomBytes(3).toString("hex").toUpperCase();
    user.resetToken = resetToken;
    user.resetTokenExpiry = new Date(Date.now() + 15 * 60 * 1000); // 15 min
    await user.save();

    // In production you'd send this via email.
    // For dev, the code is logged to the server console only.
    console.log(`[Password Reset] User: ${user.username}, Code: ${resetToken}`);

    // Send email if SMTP is configured
    if (process.env.SMTP_USER && process.env.SMTP_PASS) {
      try {
        await transporter.sendMail({
          from: `"Study Room" <${process.env.SMTP_USER}>`,
          to: email,
          subject: "Your Password Reset Code",
          html: `
            <div style="font-family:sans-serif;max-width:400px;margin:0 auto;padding:24px;background:#111;color:#fff;border-radius:12px;">
              <h2 style="margin:0 0 8px;color:#fff;">Password Reset</h2>
              <p style="color:#aaa;font-size:14px;">Use the code below to reset your password. It expires in 15 minutes.</p>
              <div style="text-align:center;margin:24px 0;">
                <span style="display:inline-block;background:#222;padding:14px 28px;border-radius:8px;font-size:28px;letter-spacing:6px;font-weight:700;color:#fff;border:1px solid #333;">${resetToken}</span>
              </div>
              <p style="color:#666;font-size:12px;text-align:center;">If you didn't request this, ignore this email.</p>
            </div>
          `
        });
      } catch (emailErr) {
        console.error("[Email Error]", emailErr.message);
      }
    }

    res.json({
      message: "If an account with that email exists, a reset code has been sent to your inbox."
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Reset password — verify token + set new password
exports.resetPassword = async (req, res) => {
  try {
    const { email, resetCode, newPassword } = req.body;

    if (!strongPasswordRegex.test(newPassword)) {
      return res.status(400).json({
        message: "Password must be at least 8 characters with 1 uppercase, 1 lowercase, 1 number, and 1 symbol"
      });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ message: "No account found with that email" });
    }

    if (!user.resetToken || user.resetToken !== resetCode) {
      return res.status(400).json({ message: "Invalid reset code" });
    }

    if (user.resetTokenExpiry < new Date()) {
      return res.status(400).json({ message: "Reset code has expired" });
    }

    user.password = await bcrypt.hash(newPassword, 10);
    user.resetToken = null;
    user.resetTokenExpiry = null;
    await user.save();

    res.json({ message: "Password reset successful" });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};