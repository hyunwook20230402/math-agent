// 새로운 데이터베이스 스키마에 맞춰 타입 정의
export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          user_id: string;
          email: string;
          name: string;
          role: 'teacher' | 'student';
          avatar_url: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          email: string;
          name: string;
          role: 'teacher' | 'student';
          avatar_url?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          email?: string;
          name?: string;
          role?: 'teacher' | 'student';
          avatar_url?: string | null;
          created_at?: string;
          updated_at?: string;
        };
      };
      problems: {
        Row: {
          id: string;
          teacher_id: string;
          title: string;
          problem_number: number;
          difficulty: 'easy' | 'medium' | 'hard';
          category: string; // 카테고리 (예: '수학', '기하', '대수' 등)
          unit: string; // 단원
          image_url: string | null; // 문제 이미지 URL
          answer_type: 'multiple_choice' | 'short_answer';
          correct_answer: string;
          choices: any | null; // 객관식 보기
          explanation: string | null; // 해설
          tags: string[] | null; // 태그 이름 배열
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          teacher_id: string;
          title: string;
          problem_number: number;
          difficulty: 'easy' | 'medium' | 'hard';
          category: string;
          unit: string;
          image_url?: string | null;
          answer_type: 'multiple_choice' | 'short_answer';
          correct_answer: string;
          choices?: any | null;
          explanation?: string | null;
          tags?: string[] | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          teacher_id?: string;
          title?: string;
          problem_number?: number;
          difficulty?: 'easy' | 'medium' | 'hard';
          category?: string;
          unit?: string;
          image_url?: string | null;
          answer_type?: 'multiple_choice' | 'short_answer';
          correct_answer?: string;
          choices?: any | null;
          explanation?: string | null;
          tags?: string[] | null;
          created_at?: string;
          updated_at?: string;
        };
      };
      student_answers: {
        Row: {
          id: string;
          student_id: string;
          problem_id: string;
          answer: string;
          is_correct: boolean;
          submitted_at: string;
          attempt_number: number;
          distribution_id: string | null;
        };
        Insert: {
          id?: string;
          student_id: string;
          problem_id: string;
          answer: string;
          is_correct: boolean;
          submitted_at?: string;
          attempt_number?: number;
          distribution_id?: string | null;
        };
        Update: {
          id?: string;
          student_id?: string;
          problem_id?: string;
          answer?: string;
          is_correct?: boolean;
          submitted_at?: string;
          attempt_number?: number;
          distribution_id?: string | null;
        };
      };
      wrong_answers: {
        Row: {
          id: string;
          student_id: string;
          problem_id: string;
          wrong_answer: string;
          created_at: string;
          reviewed: boolean;
        };
        Insert: {
          id?: string;
          student_id: string;
          problem_id: string;
          wrong_answer: string;
          created_at?: string;
          reviewed?: boolean;
        };
        Update: {
          id?: string;
          student_id?: string;
          problem_id?: string;
          wrong_answer?: string;
          created_at?: string;
          reviewed?: boolean;
        };
      };
      folders: {
        Row: {
          id: string;
          name: string; // 교재 이름 (예: "중학교 3학년 1학기 수학")
          description: string | null;
          folder_type: 'textbook'; // 교재 타입
          textbook_type: string; // 교재 종류 (예: "쎈", "자작", "기타")
          grade_level: string; // 학년 (예: "중3", "고1")
          semester: string; // 학기 (예: "1학기", "2학기")
          subject: string; // 과목 (예: "수학", "영어")
          parent_id: string | null; // 상위 교재 (선택사항)
          sort_order: number;
          created_at: string;
          updated_at: string;
          created_by: string;
        };
        Insert: {
          id?: string;
          name: string;
          description?: string | null;
          folder_type: 'textbook';
          textbook_type: string;
          grade_level: string;
          semester: string;
          subject: string;
          parent_id?: string | null;
          sort_order?: number;
          created_at?: string;
          updated_at?: string;
          created_by?: string;
        };
        Update: {
          id?: string;
          name?: string;
          description?: string | null;
          folder_type?: 'textbook';
          textbook_type?: string;
          grade_level?: string;
          semester?: string;
          subject?: string;
          parent_id?: string | null;
          sort_order?: number;
          created_at?: string;
          updated_at?: string;
          created_by?: string;
        };
      };
      problem_sets: {
        Row: {
          id: string;
          name: string; // 문제 세트 이름 (예: "1단원 쪽지시험", "기말고사 대비")
          folder_id: string; // 어떤 교재에 속하는지
          teacher_id: string;
          description: string | null;
          set_type: 'quiz' | 'exam' | 'practice' | 'review'; // 문제 세트 타입
          total_problems: number; // 총 문제 수
          estimated_time: number; // 예상 소요 시간 (분)
          difficulty_level: 'easy' | 'medium' | 'hard' | 'mixed'; // 전체 난이도
          sort_order: number;
          is_favorite: boolean;
          is_published: boolean; // 학생들에게 공개 여부
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          folder_id: string;
          teacher_id?: string;
          description?: string | null;
          set_type: 'quiz' | 'exam' | 'practice' | 'review';
          total_problems?: number;
          estimated_time?: number;
          difficulty_level?: 'easy' | 'medium' | 'hard' | 'mixed';
          sort_order?: number;
          is_favorite?: boolean;
          is_published?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          name?: string;
          folder_id?: string;
          teacher_id?: string;
          description?: string | null;
          set_type?: 'quiz' | 'exam' | 'practice' | 'review';
          total_problems?: number;
          estimated_time?: number;
          difficulty_level?: 'easy' | 'medium' | 'hard' | 'mixed';
          sort_order?: number;
          is_favorite?: boolean;
          is_published?: boolean;
          created_at?: string;
          updated_at?: string;
        };
      };
      problem_set_items: {
        Row: {
          id: string;
          problem_set_id: string;
          problem_id: string;
          sort_order: number;
          created_at: string;
        };
        Insert: {
          id?: string;
          problem_set_id: string;
          problem_id: string;
          sort_order?: number;
          created_at?: string;
        };
        Update: {
          id?: string;
          problem_set_id?: string;
          problem_id?: string;
          sort_order?: number;
          created_at?: string;
        };
      };
      distributions: {
        Row: {
          id: string;
          problem_set_id: string;
          teacher_id: string;
          title: string;
          description: string | null;
          distribution_date: string;
          is_active: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          problem_set_id: string;
          teacher_id: string;
          title: string;
          description?: string | null;
          distribution_date: string;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          problem_set_id?: string;
          teacher_id?: string;
          title?: string;
          description?: string | null;
          distribution_date?: string;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
      };
      distribution_students: {
        Row: {
          id: string;
          distribution_id: string;
          student_id: string;
          assigned_at: string;
        };
        Insert: {
          id?: string;
          distribution_id: string;
          student_id: string;
          assigned_at?: string;
        };
        Update: {
          id?: string;
          distribution_id?: string;
          student_id?: string;
          assigned_at?: string;
        };
      };
      distribution_problems: {
        Row: {
          id: string;
          distribution_id: string;
          problem_id: string;
          is_visible: boolean;
          created_at: string;
        };
        Insert: {
          id?: string;
          distribution_id: string;
          problem_id: string;
          is_visible?: boolean;
          created_at?: string;
        };
        Update: {
          id?: string;
          distribution_id?: string;
          problem_id?: string;
          is_visible?: boolean;
          created_at?: string;
        };
      };
      tags: {
        Row: {
          id: string;
          name: string;
          teacher_id: string;
          color: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          teacher_id: string;
          color?: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          name?: string;
          teacher_id?: string;
          color?: string;
          created_at?: string;
        };
      };
      problem_tags: {
        Row: {
          id: string;
          problem_id: string;
          tag_id: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          problem_id: string;
          tag_id: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          problem_id?: string;
          tag_id?: string;
          created_at?: string;
        };
      };
      student_achievements: {
        Row: {
          id: string;
          student_id: string;
          problem_set_id: string;
          total_problems: number;
          correct_answers: number;
          accuracy_rate: number;
          completed_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          student_id: string;
          problem_set_id: string;
          total_problems?: number;
          correct_answers?: number;
          accuracy_rate?: number;
          completed_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          student_id?: string;
          problem_set_id?: string;
          total_problems?: number;
          correct_answers?: number;
          accuracy_rate?: number;
          completed_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      [_ in never]: never;
    };
    Enums: {
      [_ in never]: never;
    };
  };
}

// 타입 별칭 정의
export type Tables<T extends keyof Database['public']['Tables']> = Database['public']['Tables'][T]['Row'];
export type TablesInsert<T extends keyof Database['public']['Tables']> = Database['public']['Tables'][T]['Insert'];
export type TablesUpdate<T extends keyof Database['public']['Tables']> = Database['public']['Tables'][T]['Update'];

// 특정 테이블 타입 정의
export type Profile = Tables<'profiles'>;
export type Problem = Tables<'problems'>;
export type StudentAnswer = Tables<'student_answers'>;
export type WrongAnswer = Tables<'wrong_answers'>;
export type Folder = Tables<'folders'>;
export type ProblemSet = Tables<'problem_sets'>;
export type ProblemSetItem = Tables<'problem_set_items'>;
export type Distribution = Tables<'distributions'>;
export type DistributionStudent = Tables<'distribution_students'>;
export type DistributionProblem = Tables<'distribution_problems'>;
export type Tag = Tables<'tags'>;
export type ProblemTag = Tables<'problem_tags'>;
export type StudentAchievement = Tables<'student_achievements'>;

// 새로운 교재/단원 구조 타입들
export interface Textbook {
  id: string;
  name: string;
  grade: string;
  semester: string;
  description?: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface Chapter {
  id: string;
  textbook_id: string;
  name: string;
  description?: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface Subchapter {
  id: string;
  chapter_id: string;
  name: string;
  description?: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface ProblemSetNew {
  id: string;
  subchapter_id: string;
  name: string;
  description?: string;
  is_published: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface ProblemTagNew {
  id: string;
  problem_id: string;
  tag_id: string;
  created_at: string;
}

// 확장된 타입들
export interface ProblemWithTagsNew {
  id: string;
  teacher_id: string;
  title: string;
  problem_number: number;
  difficulty: "easy" | "medium" | "hard";
  category: string;
  unit: string;
  image_url: string;
  answer_type: "multiple_choice" | "short_answer";
  correct_answer: string;
  choices: string[];
  explanation: string;
  created_at: string;
  updated_at: string;
  tags: string[]; // 태그 이름 배열
}

export interface ProblemSetWithDetails extends ProblemSetNew {
  subchapter: Subchapter;
  problems: Problem[];
  problem_count: number;
}

export interface SubchapterWithDetails extends Subchapter {
  chapter: Chapter;
  problem_sets: ProblemSetNew[];
}

export interface ChapterWithDetails extends Chapter {
  textbook: Textbook;
  subchapters: SubchapterWithDetails[];
}

export interface TextbookWithDetails extends Textbook {
  chapters: ChapterWithDetails[];
}

// API 타입들
export interface CreateTextbookRequest {
  name: string;
  grade: string;
  semester: string;
  description?: string;
}

export interface CreateChapterRequest {
  textbook_id: string;
  name: string;
  description?: string;
  sort_order?: number;
}

export interface CreateSubchapterRequest {
  chapter_id: string;
  name: string;
  description?: string;
  sort_order?: number;
}

export interface CreateProblemSetRequest {
  subchapter_id: string;
  name: string;
  description?: string;
  is_published?: boolean;
}

export interface CreateProblemRequest {
  problem_set_id: string;
  title: string;
  problem_number?: number;
  difficulty_level: number; // 1-5
  problem_type: 'multiple_choice' | 'short_answer' | 'essay';
  image_url?: string;
  correct_answer: string;
  choices?: string[];
  multiple_answers?: string[];
  explanation?: string;
  explanation_image_url?: string;
  tag_ids?: string[];
}

// 확장된 타입 정의
export interface ProblemWithTags extends Omit<Problem, 'tags'> {
  tags: Tag[];
}

export interface ProblemSetWithProblems extends ProblemSet {
  problems: Problem[];
  problem_count: number;
}

export interface DistributionWithDetails extends Distribution {
  problem_set: ProblemSetWithProblems;
  students: Profile[];
  visible_problems: Problem[];
}

export interface FolderWithChildren extends Folder {
  children: Folder[];
  problem_sets: ProblemSet[];
}

export interface StudentAchievementWithDetails extends StudentAchievement {
  problem_set: ProblemSet;
  student: Profile;
}