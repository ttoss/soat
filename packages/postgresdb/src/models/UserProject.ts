import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { Project } from './Project';
import { ProjectPolicy } from './ProjectPolicy';
import { User } from './User';

@Table({
  tableName: 'user_projects',
  indexes: [{ unique: true, fields: ['user_id', 'project_id'] }],
})
export class UserProject extends Model {
  @ForeignKey(() => {
    return User;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare userId: number;

  @BelongsTo(() => {
    return User;
  })
  declare user: User;

  @ForeignKey(() => {
    return Project;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare projectId: number;

  @BelongsTo(() => {
    return Project;
  })
  declare project: Project;

  @ForeignKey(() => {
    return ProjectPolicy;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare policyId: number;

  @BelongsTo(() => {
    return ProjectPolicy;
  })
  declare policy: ProjectPolicy;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
