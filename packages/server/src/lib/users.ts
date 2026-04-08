import { db } from '../db';
import {
  comparePassword,
  hashPassword,
  signUserToken,
} from '../middleware/auth';

const mapUser = (user: InstanceType<(typeof db)['User']>) => {
  return {
    id: user.publicId,
    username: user.username,
    role: user.role,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
};

export const listUsers = async () => {
  const allUsers = await db.User.findAll();
  return allUsers.map(mapUser);
};

export const getUser = async (args: { id: string }) => {
  const user = await db.User.findOne({ where: { publicId: args.id } });

  if (!user) {
    return null;
  }

  return mapUser(user);
};

export const loginUser = async (args: {
  username: string;
  password: string;
}) => {
  const user = await db.User.findOne({ where: { username: args.username } });

  if (!user) {
    return null;
  }

  const valid = await comparePassword(
    args.password,
    user.passwordHash as string
  );

  if (!valid) {
    return null;
  }

  const token = signUserToken({
    publicId: user.publicId as string,
    role: user.role as string,
  });

  return { ...mapUser(user), token };
};

export const createUser = async (args: {
  username: string;
  password: string;
  role?: 'admin' | 'user';
}) => {
  const passwordHash = await hashPassword(args.password);
  const user = await db.User.create({
    username: args.username,
    passwordHash,
    role: args.role ?? 'user',
  });

  return mapUser(user);
};

export const createFirstAdminUser = async (args: {
  username: string;
  password: string;
}) => {
  const count = await db.User.count();

  if (count > 0) {
    return null;
  }

  const passwordHash = await hashPassword(args.password);
  const user = await db.User.create({
    username: args.username,
    passwordHash,
    role: 'admin',
  });

  return mapUser(user);
};

export const deleteUser = async (args: { id: string }) => {
  const user = await db.User.findOne({ where: { publicId: args.id } });

  if (!user) {
    return false;
  }

  await user.destroy();
  return true;
};
