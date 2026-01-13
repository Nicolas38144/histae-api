export class RegisterDto {
  email: string;
  phone_number: string;
  password: string;
  firstname: string;
  birthdate: string; // ISO string, ex: "1990-01-01"
  sex: 'male' | 'female' | 'other';
  bio?: string;
}
