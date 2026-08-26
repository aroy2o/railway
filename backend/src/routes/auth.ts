/**
 * `/api/auth` - FR10.2. Login only; no self-registration.
 *
 * The seed script (`npm run seed`) owns the four fixed demo accounts - see
 * `DEMO_ACCOUNTS.md` at the repo root for their credentials.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';

import { User } from '../models/index.js';
import { validate, validated } from '../middleware/validate.js';
import { signToken, verifyPassword } from '../services/authTokens.js';
import { ApiError } from '../utils/ApiError.js';

const router = Router();

const loginSchema = z
  .object({
    username: z.string().min(1).max(64),
    password: z.string().min(1).max(200),
  })
  .strict();
type LoginBody = z.infer<typeof loginSchema>;

router.post(
  '/login',
  validate({ body: loginSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { username, password } = validated<LoginBody>(req.body);

      const user = await User.findOne({ username }).lean();
      // Same message whether the username doesn't exist or the password is
      // wrong - distinguishing them would let a client enumerate valid
      // usernames against a login endpoint.
      const invalid = () => ApiError.unauthorized('Invalid username or password');

      if (!user) throw invalid();
      if (!(await verifyPassword(password, user.passwordHash))) throw invalid();

      const token = signToken({
        sub: user._id,
        username: user.username,
        role: user.role,
        department: user.department,
        name: user.name,
      });

      res.json({
        data: {
          token,
          user: {
            id: user._id,
            username: user.username,
            role: user.role,
            department: user.department,
            name: user.name,
          },
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
