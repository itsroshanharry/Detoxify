import mongoose, {Model, Document, Schema} from 'mongoose';

export interface IUser {
  email: string;
  fullName: string;
  avatar: string;
  accessToken: string;
  refreshToken: string;
}

export interface IUserDocument extends IUser, Document  {
  createdAt: Date;
  updatedAt: Date;
};

const userSchema = new mongoose.Schema<IUserDocument>({
  email: {
    type: String,
    required: true,
    unique: true,
  },
  fullName: {
    type: String,
    required: true,
  },
  avatar: {
    type: String,
  },
  accessToken: {
    type: String,
  },
  refreshToken: {
    type: String,
  },
}, {
  timestamps: true,
});

const UserModel:Model<IUser> = mongoose.models.User || mongoose.model('User', userSchema);

export default UserModel;